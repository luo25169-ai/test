import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserLocator, BrowserPage } from "./zhihu-browser.js";

export const wechatLoginUrl = "https://mp.weixin.qq.com/";
export const wechatArticleEditUrl = "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit";

export interface WechatPublishDraft {
  title: string;
  body: string;
  tags: string[];
  images: Array<{ name: string; url: string; type?: string }>;
}

export interface BrowserFrameLocator {
  locator(selector: string): BrowserLocator;
}

export interface WechatBrowserPage extends BrowserPage {
  frameLocator?(selector: string): BrowserFrameLocator;
  evaluate?<T>(pageFunction: (arg: string) => T, arg: string): Promise<T>;
  evaluateExpression?<T>(expression: string): Promise<T>;
  keyboard?: BrowserPage["keyboard"] & {
    insertText?(text: string): Promise<void>;
  };
  mouse?: {
    click(x: number, y: number): Promise<void>;
  };
}

export interface WechatBrowserPublisher {
  openLoginPage(): Promise<{ url: string; connected?: boolean }>;
  publish(draft: WechatPublishDraft): Promise<{
    status: "SUCCESS" | "NEEDS_LOGIN" | "NEEDS_USER_ACTION";
    message: string;
    publishedUrl?: string;
  }>;
}

export interface WechatBrowserPublisherOptions {
  openPage?: () => Promise<WechatBrowserPage>;
  openManagedPage?: () => Promise<WechatBrowserPage>;
  executablePath?: string;
  profileDir?: string;
  headless?: boolean;
}

const defaultChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const managedRemoteDebuggingPort = Number(process.env.CONTENTFLOW_WECHAT_BROWSER_PORT ?? 9223);
const managedProfileDir =
  process.env.CONTENTFLOW_WECHAT_BROWSER_PROFILE_DIR ?? resolve(process.cwd(), "../../.contentflow-browser/wechat-managed");

let persistentPage: WechatBrowserPage | null = null;
let persistentPagePromise: Promise<WechatBrowserPage> | null = null;
let managedBrowserPromise: Promise<any> | null = null;

function activateChromeWindow(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Google Chrome" to activate'], {
      stdio: "ignore"
    });
  } catch {
    // Best effort only. If activation fails, the page can still be opened in Chrome.
  }
}

function wrapLocator(locator: any): BrowserLocator {
  return {
    async count() {
      return locator.count();
    },
    first() {
      return wrapLocator(locator.first());
    },
    async fill(value: string) {
      await locator.fill(value);
    },
    async click() {
      await locator.click();
    },
    async isVisible() {
      return locator.isVisible();
    }
  };
}

function wrapFrameLocator(frameLocator: any): BrowserFrameLocator {
  return {
    locator(selector: string) {
      return wrapLocator(frameLocator.locator(selector));
    }
  };
}

function wrapPage(page: any): WechatBrowserPage {
  return {
    async goto(url: string, options?: { waitUntil?: "domcontentloaded" | "load" | "networkidle" }) {
      await page.goto(url, options);
    },
    async waitForLoadState(state: "domcontentloaded" | "load" | "networkidle") {
      await page.waitForLoadState(state);
    },
    url() {
      return page.url();
    },
    locator(selector: string) {
      return wrapLocator(page.locator(selector));
    },
    getByPlaceholder(text: string, options?: { exact?: boolean }) {
      return wrapLocator(page.getByPlaceholder(text, options));
    },
    getByText(text: string, options?: { exact?: boolean }) {
      return wrapLocator(page.getByText(text, options));
    },
    frameLocator:
      typeof page.frameLocator === "function"
        ? (selector: string) => wrapFrameLocator(page.frameLocator(selector))
        : undefined,
    keyboard:
      page.keyboard && typeof page.keyboard.type === "function"
        ? {
            async type(text: string) {
              await page.keyboard.type(text);
            },
            async press(key: string) {
              await page.keyboard.press(key);
            },
            insertText:
              typeof page.keyboard.insertText === "function"
                ? async (text: string) => {
                    await page.keyboard.insertText(text);
                  }
                : undefined
          }
        : undefined,
    mouse:
      page.mouse && typeof page.mouse.click === "function"
        ? {
            async click(x: number, y: number) {
              await page.mouse.click(x, y);
            }
          }
        : undefined,
    isClosed() {
      return typeof page.isClosed === "function" ? page.isClosed() : false;
    },
    async bringToFront() {
      if (typeof page.bringToFront === "function") {
        await page.bringToFront();
      }
    },
    evaluate:
      typeof page.evaluate === "function"
        ? async <T>(pageFunction: (arg: string) => T, arg: string) => page.evaluate(pageFunction, arg)
        : undefined,
    evaluateExpression:
      typeof page.evaluate === "function"
        ? async <T>(expression: string) => page.evaluate(expression)
        : undefined
  };
}

async function waitForRemoteDebugger(port: number): Promise<void> {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`无法连接到公众号浏览器调试端口 ${port}`);
}

async function ensureManagedBrowser(
  chromium: Awaited<typeof import("playwright-core")>["chromium"],
  executablePath: string,
  headless: boolean
): Promise<any> {
  if (managedBrowserPromise) return managedBrowserPromise;

  managedBrowserPromise = (async () => {
    const endpoint = `http://127.0.0.1:${managedRemoteDebuggingPort}`;
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch {
      await mkdir(managedProfileDir, { recursive: true });
      spawn(
        executablePath,
        [
          `--remote-debugging-port=${managedRemoteDebuggingPort}`,
          `--user-data-dir=${managedProfileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-sync",
          "--disable-background-networking",
          "--disable-popup-blocking",
          "--disable-infobars",
          "--enable-unsafe-swiftshader",
          headless ? "--headless=new" : "--start-maximized"
        ].filter(Boolean),
        {
          detached: true,
          stdio: "ignore"
        }
      ).unref();
      await waitForRemoteDebugger(managedRemoteDebuggingPort);
      return chromium.connectOverCDP(endpoint);
    }
  })();

  try {
    return await managedBrowserPromise;
  } catch (error) {
    managedBrowserPromise = null;
    throw error;
  }
}

async function ensureManagedPage(browser: any): Promise<WechatBrowserPage> {
  const contexts = browser.contexts();
  const context = contexts[0] ?? (await browser.newContext());
  const pages = context.pages();
  const platformPage = pages.find((page: any) => {
    const url = typeof page.url === "function" ? page.url() : "";
    return url.includes("mp.weixin.qq.com");
  });
  return wrapPage(platformPage ?? (await context.newPage()));
}

async function ensurePersistentPage(options: WechatBrowserPublisherOptions): Promise<WechatBrowserPage> {
  if (options.openPage) return wrapPage(await options.openPage());
  if (options.openManagedPage) return wrapPage(await options.openManagedPage());

  const { chromium } = await import("playwright-core");
  const executablePath = options.executablePath ?? process.env.CONTENTFLOW_CHROME_PATH ?? defaultChromePath;
  const headless = options.headless ?? false;
  const browser = await ensureManagedBrowser(chromium, executablePath, headless);
  return ensureManagedPage(browser);
}

async function gotoAndIgnoreAbort(page: WechatBrowserPage, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ERR_ABORTED")) {
      throw error;
    }
  }
}

async function findFirstVisibleLocator(root: { locator(selector: string): BrowserLocator }, selectors: string[]): Promise<BrowserLocator | null> {
  for (const selector of selectors) {
    const locator = root.locator(selector);
    if ((await locator.count()) > 0 && (await locator.first().isVisible())) {
      return locator.first();
    }
  }
  return null;
}

async function findFirstVisibleText(page: WechatBrowserPage, texts: string[]): Promise<BrowserLocator | null> {
  for (const text of texts) {
    const locator = page.getByText(text, { exact: false });
    if ((await locator.count()) > 0 && (await locator.first().isVisible())) {
      return locator.first();
    }
  }
  return null;
}

async function fillFirstVisible(root: { locator(selector: string): BrowserLocator }, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = root.locator(selector);
    if ((await locator.count()) === 0 || !(await locator.first().isVisible())) continue;
    try {
      await locator.first().fill(value);
      return true;
    } catch {
      // Some WeChat editor containers are visible wrappers rather than real inputs.
      // Keep probing more specific editable nodes instead of failing the whole task.
    }
  }
  return false;
}

async function fillFirstVisiblePlaceholder(page: WechatBrowserPage, placeholders: string[], value: string): Promise<boolean> {
  for (const placeholder of placeholders) {
    const locator = page.getByPlaceholder(placeholder, { exact: false });
    if ((await locator.count()) > 0 && (await locator.first().isVisible())) {
      await locator.first().fill(value);
      return true;
    }
  }
  return false;
}

async function isWechatLoginRequired(page: WechatBrowserPage): Promise<boolean> {
  const currentUrl = page.url();
  if (currentUrl.includes("/cgi-bin/loginpage") || currentUrl.includes("login")) return true;
  if ((await findFirstVisibleText(page, ["登录超时", "请重新登录", "扫码登录", "微信号登录"])) !== null) return true;
  const loginHints = await findFirstVisibleLocator(page, [
    ".login__type__container",
    ".login_frame",
    "[class*='login']"
  ]);
  return loginHints !== null;
}

function createWechatArticleEditUrl(page: WechatBrowserPage): string {
  try {
    const token = new URL(page.url()).searchParams.get("token");
    if (token) {
      return `${wechatArticleEditUrl}&action=edit&type=10&lang=zh_CN&token=${token}`;
    }
  } catch {
    // Fall back to the base URL below.
  }
  return wechatArticleEditUrl;
}

async function isWechatAccountProfileBlockingEditor(page: WechatBrowserPage): Promise<boolean> {
  return (await findFirstVisibleText(page, ["当前公众号名称", "请尽快修改名称", "修改名称"])) !== null;
}

async function fillWechatBodyByRealInput(page: WechatBrowserPage, body: string): Promise<boolean> {
  if (!page.evaluateExpression || !page.mouse || !page.keyboard) return false;
  const target = await page.evaluateExpression<{
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(`(() => {
    const titleSelectors = [
      "#title",
      "#activity-name",
      "#js_title",
      "#js_title_area",
      "input[name='title']",
      "textarea[name='title']",
      "[placeholder*='标题']",
      "[data-placeholder*='标题']",
      "[aria-label*='标题']",
      "[class*='title']",
      "[id*='title']"
    ];
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const isTitleLike = (element) => titleSelectors.some((selector) => element.matches?.(selector) || element.closest?.(selector));
    const candidates = Array.from(document.querySelectorAll(".ProseMirror[contenteditable='true'], [contenteditable='true']"))
      .filter((element) => isVisible(element) && !isTitleLike(element))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          text: String(element.innerText || element.textContent || "").trim(),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        };
      });
    return candidates.find((item) => item.text.includes("从这里开始写正文")) ?? candidates.sort((a, b) => b.height - a.height)[0] ?? null;
  })()`);
  if (!target || target.width <= 0 || target.height <= 0) return false;

  const clickX = Math.round(target.x + Math.min(target.width / 2, 260));
  const clickY = Math.round(target.y + Math.min(target.height / 2, 60));
  await page.mouse.click(clickX, clickY);
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (page.keyboard.insertText) {
    await page.keyboard.insertText(body);
  } else {
    await page.keyboard.type(body);
  }
  return true;
}

async function fillWechatBodyByPageScript(page: WechatBrowserPage, body: string): Promise<boolean> {
  if (!page.evaluate) return false;
  return page.evaluate((rawBody) => {
    const doc = (globalThis as any).document;
    const win = globalThis as any;
    const titleSelectors = [
      "#title",
      "#activity-name",
      "#js_title",
      "#js_title_area",
      "input[name='title']",
      "textarea[name='title']",
      "[placeholder*='标题']",
      "[data-placeholder*='标题']",
      "[aria-label*='标题']",
      "[class*='title']",
      "[id*='title']"
    ];
    const isVisible = (element: any) => {
      const rect = element.getBoundingClientRect();
      const style = win.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const isTitleLike = (element: any) => titleSelectors.some((selector) => element.matches?.(selector) || element.closest?.(selector));
    const insertInto = (element: any) => {
      if (!element || isTitleLike(element)) return false;
      element.scrollIntoView?.({ block: "center", inline: "center" });
      element.click?.();
      element.focus?.();
      const editable = element.closest?.("[contenteditable='true']") ?? element;
      if (!editable || isTitleLike(editable)) return false;
      if (editable.tagName === "TEXTAREA" || editable.tagName === "INPUT") {
        const prototype = editable.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(editable, rawBody);
        else editable.value = rawBody;
        editable.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: rawBody }));
        editable.dispatchEvent(new win.Event("change", { bubbles: true }));
        return true;
      }
      if (editable.getAttribute?.("contenteditable") === "true") {
        editable.textContent = "";
        editable.dispatchEvent(new win.InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: rawBody }));
        doc.execCommand("insertText", false, rawBody);
        editable.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: rawBody }));
        return true;
      }
      return false;
    };

    const placeholderMatches = Array.from(doc.querySelectorAll("div, p, span, section, [contenteditable='true']")).filter((element: any) => {
      const text = [
        element.innerText,
        element.textContent,
        element.getAttribute?.("placeholder"),
        element.getAttribute?.("data-placeholder"),
        element.getAttribute?.("aria-label")
      ]
        .filter(Boolean)
        .join(" ");
      return isVisible(element) && !isTitleLike(element) && (text.includes("从这里开始写正文") || text.includes("请输入正文"));
    }) as any[];
    for (const placeholder of placeholderMatches) {
      if (insertInto(placeholder)) return true;
      const editable = placeholder.closest?.("[contenteditable='true']");
      if (insertInto(editable)) return true;
      const nearbyEditable =
        placeholder.parentElement?.querySelector?.("[contenteditable='true']") ??
        placeholder.parentElement?.parentElement?.querySelector?.("[contenteditable='true']");
      if (insertInto(nearbyEditable)) return true;
    }

    const titleBottom = Math.max(
      0,
      ...titleSelectors.flatMap((selector) =>
        Array.from(doc.querySelectorAll(selector))
          .filter(isVisible)
          .map((element: any) => element.getBoundingClientRect().bottom)
      )
    );
    const editableCandidates = Array.from(
      doc.querySelectorAll(
        "[contenteditable='true'][data-placeholder*='正文'], [contenteditable='true'][aria-label*='正文'], [contenteditable='true'][placeholder*='正文'], #js_editor [contenteditable='true'], .editor [contenteditable='true'], .ProseMirror, .ql-editor"
      )
    ).filter((element: any) => {
      const rect = element.getBoundingClientRect();
      return isVisible(element) && !isTitleLike(element) && rect.top > titleBottom;
    }) as any[];
    for (const candidate of editableCandidates) {
      if (insertInto(candidate)) return true;
    }

    for (const frame of Array.from(doc.querySelectorAll("iframe")) as any[]) {
      const frameDoc = frame.contentDocument;
      if (!frameDoc) continue;
      const frameCandidates = Array.from(
        frameDoc.querySelectorAll("body[contenteditable='true'], [contenteditable='true'], .ProseMirror, .ql-editor, #js_editor, .editor, body")
      ).filter((element: any) => isVisible(element)) as any[];
      for (const candidate of frameCandidates) {
        candidate.scrollIntoView?.({ block: "center", inline: "center" });
        candidate.click?.();
        candidate.focus?.();
        if (candidate.getAttribute?.("contenteditable") === "true" || candidate.tagName === "BODY") {
          candidate.textContent = "";
          frameDoc.execCommand("insertText", false, rawBody);
          candidate.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: rawBody }));
          return true;
        }
      }
    }
    return false;
  }, body);
}

async function fillWechatBody(page: WechatBrowserPage, body: string): Promise<boolean> {
  if (await fillWechatBodyByRealInput(page, body)) return true;
  if (await fillWechatBodyByPageScript(page, body)) return true;

  const pageBodySelectors = [
    "[contenteditable='true'][data-placeholder*='正文']",
    "[contenteditable='true'][aria-label*='正文']",
    "[contenteditable='true'][placeholder*='正文']",
    "#js_editor [contenteditable='true']",
    ".editor [contenteditable='true']",
    ".ProseMirror",
    ".ql-editor"
  ];

  if (await fillFirstVisible(page, pageBodySelectors, body)) return true;

  if (!page.frameLocator) return false;
  const frameBodySelectors = [
    "body[contenteditable='true']",
    "[contenteditable='true']",
    ".ProseMirror",
    ".ql-editor",
    "#js_editor",
    ".editor",
    "body"
  ];
  for (const frameSelector of ["iframe#ueditor_0", "iframe[id*='ueditor']", "iframe[id*='editor']", "iframe"]) {
    const frame = page.frameLocator(frameSelector);
    if (await fillFirstVisible(frame, frameBodySelectors, body)) return true;
  }
  return false;
}

async function fillWechatTitle(page: WechatBrowserPage, title: string): Promise<boolean> {
  const titleSelectors = [
    "#title",
    "#activity-name",
    "#js_title",
    "#js_title_area",
    "input[name='title']",
    "textarea[name='title']",
    "input[placeholder*='标题']",
    "textarea[placeholder*='标题']",
    "[placeholder*='标题']",
    "[data-placeholder*='标题']",
    "[aria-label*='标题']",
    "[contenteditable='true'][data-placeholder*='标题']",
    "[contenteditable='true'][aria-label*='标题']",
    "[class*='title'] input",
    "[class*='title'] textarea",
    "[class*='title'][contenteditable='true']",
    "[id*='title'] input",
    "[id*='title'] textarea",
    "[id*='title'][contenteditable='true']"
  ];

  if (await fillFirstVisible(page, titleSelectors, title)) return true;
  if (await fillFirstVisiblePlaceholder(page, ["请在这里输入标题", "请输入标题", "填写标题", "标题"], title)) return true;

  if (!page.evaluate) return false;
  return page.evaluate((rawTitle) => {
    const doc = (globalThis as any).document;
    const win = globalThis as any;
    const selectors = [
      "#title",
      "#activity-name",
      "#js_title",
      "#js_title_area",
      "input[name='title']",
      "textarea[name='title']",
      "input[placeholder*='标题']",
      "textarea[placeholder*='标题']",
      "[placeholder*='标题']",
      "[data-placeholder*='标题']",
      "[aria-label*='标题']",
      "[contenteditable='true'][data-placeholder*='标题']",
      "[contenteditable='true'][aria-label*='标题']",
      "[class*='title'] input",
      "[class*='title'] textarea",
      "[class*='title'][contenteditable='true']",
      "[id*='title'] input",
      "[id*='title'] textarea",
      "[id*='title'][contenteditable='true']"
    ];
    const isVisible = (element: any) => {
      const rect = element.getBoundingClientRect();
      const style = win.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = selectors.flatMap((selector) => Array.from(doc.querySelectorAll(selector)));
    const element = candidates.find(isVisible) as any;
    if (!element) return false;
    element.scrollIntoView?.({ block: "center", inline: "center" });
    element.click?.();
    element.focus?.();
    const editable = element.closest?.("[contenteditable='true']") ?? element;
    if (editable.tagName === "TEXTAREA" || editable.tagName === "INPUT") {
      const prototype = editable.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(editable, rawTitle);
      else editable.value = rawTitle;
      editable.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: rawTitle }));
      editable.dispatchEvent(new win.Event("change", { bubbles: true }));
      return true;
    }
    if (editable.getAttribute?.("contenteditable") === "true") {
      editable.textContent = "";
      editable.dispatchEvent(new win.InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: rawTitle }));
      doc.execCommand("insertText", false, rawTitle);
      editable.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: rawTitle }));
      return true;
    }
    editable.textContent = rawTitle;
    editable.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: rawTitle }));
    editable.dispatchEvent(new win.Event("change", { bubbles: true }));
    return true;
  }, title);
}

export function createWechatBrowserPublisher(options: WechatBrowserPublisherOptions = {}): WechatBrowserPublisher {
  function resetPersistentPage(): void {
    persistentPage = null;
    persistentPagePromise = null;
  }

  async function getPage(): Promise<WechatBrowserPage> {
    if (options.openPage) return wrapPage(await options.openPage());
    if (persistentPage) {
      try {
        if (!persistentPage.isClosed()) return persistentPage;
        resetPersistentPage();
      } catch {
        resetPersistentPage();
      }
    }
    if (!persistentPagePromise) {
      persistentPagePromise = ensurePersistentPage(options);
    }
    persistentPage = await persistentPagePromise;
    return persistentPage;
  }

  return {
    async openLoginPage() {
      try {
        const page = await getPage();
        await gotoAndIgnoreAbort(page, wechatLoginUrl);
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await page.bringToFront?.();
        activateChromeWindow();
        return { url: page.url(), connected: createWechatArticleEditUrl(page) !== wechatArticleEditUrl };
      } catch (error) {
        resetPersistentPage();
        throw error;
      }
    },

    async publish(draft: WechatPublishDraft) {
      let page: WechatBrowserPage;
      try {
        page = await getPage();
        await gotoAndIgnoreAbort(page, wechatLoginUrl);
        await page.waitForLoadState("domcontentloaded");
        await page.bringToFront?.();
        activateChromeWindow();

        if (await isWechatLoginRequired(page)) {
          return {
            status: "NEEDS_LOGIN",
            message: "请先在已打开的公众号页面完成登录，再重新点击发布"
          };
        }

        await gotoAndIgnoreAbort(page, createWechatArticleEditUrl(page));
        await page.waitForLoadState("domcontentloaded");
        await page.bringToFront?.();
        activateChromeWindow();
      } catch (error) {
        resetPersistentPage();
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "NEEDS_LOGIN",
          message: message.includes("closed") ? "公众号登录窗口已关闭，请重新打开平台登录页" : "公众号页面打开失败，请重新登录后再发布"
        };
      }

      if (await isWechatLoginRequired(page)) {
        return {
          status: "NEEDS_LOGIN",
          message: "请先在已打开的公众号页面完成登录，再重新点击发布"
        };
      }

      if (await isWechatAccountProfileBlockingEditor(page)) {
        return {
          status: "NEEDS_USER_ACTION",
          message: "当前公众号资料未完成，请先在公众号后台修改公众号名称后再发布"
        };
      }

      const titleFilled = await fillWechatTitle(page, draft.title);
      if (!titleFilled) {
        return {
          status: "NEEDS_USER_ACTION",
          message: "没有找到公众号标题输入框"
        };
      }

      if (!(await fillWechatBody(page, draft.body))) {
        return {
          status: "NEEDS_USER_ACTION",
          message: "没有找到公众号正文编辑区"
        };
      }

      return {
        status: "NEEDS_USER_ACTION",
        message: "公众号草稿已填入，请确认内容后手动发布"
      };
    }
  };
}

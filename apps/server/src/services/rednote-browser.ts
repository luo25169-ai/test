import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserLocator, BrowserPage } from "./zhihu-browser.js";

export const rednoteLoginUrl = "https://creator.xiaohongshu.com/login";
export const rednotePublishUrl = "https://creator.xiaohongshu.com/publish/publish";

export interface RednotePublishDraft {
  title: string;
  body: string;
  tags: string[];
  images: Array<{ name: string; url: string; type?: string }>;
}

interface RednoteBrowserPage extends BrowserPage {
  evaluate?<T>(pageFunction: (arg: string) => T, arg: string): Promise<T>;
  mouse?: {
    click(x: number, y: number): Promise<void>;
  };
}

export interface RednoteBrowserPublisher {
  openLoginPage(): Promise<{ url: string; connected?: boolean }>;
  checkLoginStatus(): Promise<{ connected: boolean; url?: string }>;
  publish(draft: RednotePublishDraft): Promise<{
    status: "SUCCESS" | "NEEDS_LOGIN" | "NEEDS_USER_ACTION";
    message: string;
    publishedUrl?: string;
  }>;
}

export interface RednoteBrowserPublisherOptions {
  openPage?: () => Promise<RednoteBrowserPage>;
  executablePath?: string;
  headless?: boolean;
}

const defaultChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const managedRemoteDebuggingPort = Number(process.env.CONTENTFLOW_REDNOTE_BROWSER_PORT ?? 9225);
const managedProfileDir =
  process.env.CONTENTFLOW_REDNOTE_BROWSER_PROFILE_DIR ?? resolve(process.cwd(), "../../.contentflow-browser/rednote-managed");

let persistentPage: RednoteBrowserPage | null = null;
let persistentPagePromise: Promise<RednoteBrowserPage> | null = null;
let managedBrowserPromise: Promise<any> | null = null;

function activateChromeWindow(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Google Chrome" to activate'], { stdio: "ignore" });
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

function wrapPage(page: any): RednoteBrowserPage {
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
    keyboard:
      page.keyboard && typeof page.keyboard.type === "function"
        ? {
            async type(text: string) {
              await page.keyboard.type(text);
            },
            async press(key: string) {
              await page.keyboard.press(key);
            }
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
      if (typeof page.bringToFront === "function") await page.bringToFront();
    },
    evaluate:
      typeof page.evaluate === "function"
        ? async <T>(pageFunction: (arg: string) => T, arg: string) => page.evaluate(pageFunction, arg)
        : undefined
  };
}

function terminateManagedChromeProcesses(): void {
  try {
    execFileSync("pkill", ["-f", "--", `--user-data-dir=${managedProfileDir}`], { stdio: "ignore" });
  } catch {
    // The managed browser may not be running. Starting a fresh persistent context can continue.
  }
}

async function ensureManagedBrowser(
  chromium: Awaited<typeof import("playwright-core")>["chromium"],
  executablePath: string,
  headless: boolean
): Promise<any> {
  if (managedBrowserPromise) return managedBrowserPromise;

  managedBrowserPromise = (async () => {
    await mkdir(managedProfileDir, { recursive: true });
    const launch = () =>
      chromium.launchPersistentContext(managedProfileDir, {
        executablePath,
        headless,
        viewport: null,
        args: [
          `--remote-debugging-port=${managedRemoteDebuggingPort}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-sync",
          "--disable-popup-blocking",
          "--disable-infobars",
          "--enable-unsafe-swiftshader",
          headless ? "--headless=new" : "--start-maximized"
        ].filter(Boolean)
      });
    try {
      return await launch();
    } catch {
      terminateManagedChromeProcesses();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return launch();
    }
  })();

  try {
    return await managedBrowserPromise;
  } catch (error) {
    managedBrowserPromise = null;
    throw error;
  }
}

async function ensureManagedPage(browser: any): Promise<RednoteBrowserPage> {
  const context = typeof browser.contexts === "function" ? browser.contexts()[0] ?? (await browser.newContext()) : browser;
  const pages = context.pages();
  return wrapPage(pages[0] ?? (await context.newPage()));
}

async function ensurePersistentPage(options: RednoteBrowserPublisherOptions): Promise<RednoteBrowserPage> {
  if (options.openPage) return wrapPage(await options.openPage());
  const { chromium } = await import("playwright-core");
  const executablePath = options.executablePath ?? process.env.CONTENTFLOW_CHROME_PATH ?? defaultChromePath;
  const headless = options.headless ?? false;
  const browser = await ensureManagedBrowser(chromium, executablePath, headless);
  return ensureManagedPage(browser);
}

async function gotoAndIgnoreAbort(page: BrowserPage, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ERR_ABORTED")) throw error;
  }
}

function isClosedBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Target page") && message.includes("closed");
}

async function findFirstVisibleLocator(page: BrowserPage, selectors: string[]): Promise<BrowserLocator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if ((await locator.count()) > 0 && (await locator.first().isVisible())) return locator.first();
  }
  return null;
}

async function findFirstVisiblePlaceholder(page: BrowserPage, placeholders: string[]): Promise<BrowserLocator | null> {
  for (const placeholder of placeholders) {
    const locator = page.getByPlaceholder(placeholder, { exact: false });
    if ((await locator.count()) > 0 && (await locator.first().isVisible())) return locator.first();
  }
  return null;
}

async function findFirstVisibleText(page: BrowserPage, texts: string[]): Promise<BrowserLocator | null> {
  for (const text of texts) {
    const locator = page.getByText(text, { exact: false });
    if ((await locator.count()) > 0 && (await locator.first().isVisible())) return locator.first();
  }
  return null;
}

async function clickFirstVisibleText(page: RednoteBrowserPage, texts: string[]): Promise<boolean> {
  if (page.evaluate) {
    const clickTarget = await page.evaluate((rawTexts) => {
      const expectedTexts = JSON.parse(rawTexts) as string[];
      const doc = (globalThis as any).document;
      const win = globalThis as any;
      const isVisible = (element: any) => {
        const rect = element.getBoundingClientRect();
        const style = win.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < win.innerWidth &&
          rect.top < win.innerHeight &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0.01
        );
      };
      const nodes = Array.from(doc.querySelectorAll("*")) as any[];
      for (const text of expectedTexts) {
        const node = nodes.find((element) => {
          if ((element.innerText || element.textContent || "").trim() !== text) return false;
          const target = element.closest?.(".creator-tab, button, [role='button']") ?? element;
          return isVisible(target);
        });
        const target = node?.closest?.(".creator-tab, button, [role='button']") ?? node;
        if (target && isVisible(target)) {
          for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            target.dispatchEvent(new win.MouseEvent(eventName, { bubbles: true, cancelable: true, view: win }));
          }
          target.click();
          const rect = target.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
      }
      return null;
    }, JSON.stringify(texts));
    if (clickTarget) {
      if (page.mouse) {
        await page.mouse.click(clickTarget.x, clickTarget.y);
      }
      return true;
    }
  }
  const locator = await findFirstVisibleText(page, texts);
  if (!locator) return false;
  await locator.click();
  return true;
}

async function clickFirstText(page: RednoteBrowserPage, texts: string[]): Promise<boolean> {
  if (page.evaluate) {
    const clicked = await page.evaluate((rawTexts) => {
      const expectedTexts = JSON.parse(rawTexts) as string[];
      const doc = (globalThis as any).document;
      const win = globalThis as any;
      const nodes = Array.from(doc.querySelectorAll("button, [role='button'], .creator-tab, div, span")) as any[];
      for (const text of expectedTexts) {
        const node = nodes.find((element) => (element.innerText || element.textContent || "").trim() === text);
        const target = node?.closest?.("button, [role='button'], .creator-tab, .d-button, [class*='button']") ?? node;
        if (target) {
          target.scrollIntoView?.({ block: "center", inline: "center" });
          for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            target.dispatchEvent(new win.MouseEvent(eventName, { bubbles: true, cancelable: true, view: win }));
          }
          target.click();
          return true;
        }
      }
      return false;
    }, JSON.stringify(texts));
    if (clicked) return true;
  }
  return clickFirstVisibleText(page, texts);
}

async function waitForAnyVisible(page: BrowserPage, checks: Array<() => Promise<BrowserLocator | null>>, timeoutMs = 8000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const check of checks) {
      if (await check()) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs = 15000,
  intervalMs = 500
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function switchToRednoteImageTextTab(page: RednoteBrowserPage): Promise<void> {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if ((await findFirstVisiblePlaceholder(page, ["填写标题", "请输入标题", "标题"])) !== null) return;
    if ((await findFirstVisibleText(page, ["上传图片", "文字配图", "写文字", "生成图片"])) !== null) return;
    await clickFirstVisibleText(page, ["上传图文"]);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

async function isRednoteFinalEditor(page: BrowserPage): Promise<boolean> {
  return (await findFirstVisiblePlaceholder(page, ["填写标题会有更多赞哦", "填写标题", "请输入标题", "标题"])) !== null;
}

async function isRednotePublishPageReady(page: BrowserPage): Promise<boolean> {
  return (
    page.url().includes("creator.xiaohongshu.com/publish") &&
    (await findFirstVisibleText(page, ["写文字", "上传图片", "文字配图", "上传视频", "上传图文"])) !== null
  );
}

async function isRednoteLoginRequired(page: BrowserPage): Promise<boolean> {
  const currentUrl = page.url();
  if (currentUrl.includes("/login")) return true;
  if (
    (await findFirstVisibleText(page, ["小红书创作服务平台", "发布笔记", "创作中心", "笔记管理", "数据中心"])) !== null
  ) {
    return false;
  }
  if ((await findFirstVisibleLocator(page, ["[class*='login']", ".login-container", ".login-panel"])) !== null) return true;
  return (await findFirstVisibleText(page, ["扫码登录", "手机号登录", "密码登录", "登录小红书"])) !== null;
}

async function fillText(page: RednoteBrowserPage, locator: BrowserLocator, value: string): Promise<void> {
  await locator.click();
  if (page.evaluate) {
    const filled = await page.evaluate((text) => {
      const win = globalThis as any;
      const doc = win.document;
      const element = doc.activeElement;
      if (!element) return false;
      const editable = element.closest?.("[contenteditable='true']") ?? element;
      if (editable.tagName === "TEXTAREA" || editable.tagName === "INPUT") {
        editable.value = text;
        editable.dispatchEvent(new Event("input", { bubbles: true }));
        editable.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      if (editable.getAttribute?.("contenteditable") === "true") {
        editable.focus();
        editable.textContent = "";
        editable.dispatchEvent(new win.InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: text }));
        doc.execCommand("selectAll", false);
        doc.execCommand("insertText", false, text);
        editable.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        return true;
      }
      return false;
    }, value);
    if (filled) return;
  }
  if (page.keyboard) {
    await page.keyboard.press("Meta+A");
  }
  await locator.fill(value);
}

async function fillRednoteForm(
  page: RednoteBrowserPage,
  title: string,
  body: string
): Promise<"NOTE_EDITOR" | "TEXT_TO_IMAGE" | null> {
  const titleLocator =
    (await findFirstVisiblePlaceholder(page, ["填写标题会有更多赞哦", "填写标题", "请输入标题", "标题"])) ??
    (await findFirstVisibleLocator(page, ["input[placeholder*='标题']", "textarea[placeholder*='标题']", "[class*='title'] input"]));
  const bodyLocator =
    (await findFirstVisiblePlaceholder(page, ["填写正文", "输入正文", "添加正文", "描述", "分享"])) ??
    (await findFirstVisibleLocator(page, [
      "textarea[placeholder*='正文']",
      "textarea[placeholder*='描述']",
      ".publish-page-content [contenteditable='true']",
      ".editor-container [contenteditable='true']",
      "[contenteditable='true']",
      "[class*='editor']"
    ]));
  if (!bodyLocator) return null;
  if (!titleLocator && (await findFirstVisibleText(page, ["写文字", "生成图片", "再写一张"])) !== null) {
    await fillText(page, bodyLocator, `${title}\n\n${body}`);
    return "TEXT_TO_IMAGE";
  }
  if (!titleLocator) return null;
  await fillText(page, titleLocator, title);
  await fillText(page, bodyLocator, body);
  return "NOTE_EDITOR";
}

async function clickFirstGeneratedImage(page: RednoteBrowserPage): Promise<boolean> {
  if (!page.evaluate) return false;
  return page.evaluate(() => {
    const doc = (globalThis as any).document;
    const win = globalThis as any;
    const candidates = Array.from(doc.querySelectorAll("img, canvas, [class*='image'], [class*='cover'], [class*='card']")) as any[];
    const target = candidates.find((element) => {
      const rect = element.getBoundingClientRect();
      const style = win.getComputedStyle(element);
      return rect.width >= 40 && rect.height >= 40 && style.display !== "none" && style.visibility !== "hidden";
    });
    if (!target) return false;
    target.scrollIntoView?.({ block: "center", inline: "center" });
    target.click();
    return true;
  }, "");
}

async function runRednoteTextToImageFlow(page: RednoteBrowserPage, title: string, body: string): Promise<void> {
  if (await isRednoteFinalEditor(page)) return;

  await switchToRednoteImageTextTab(page);
  if (await isRednoteFinalEditor(page)) return;

  if ((await findFirstVisibleText(page, ["上传图片", "文字配图"])) !== null) {
    await clickFirstText(page, ["文字配图"]);
  }
  await waitForAnyVisible(page, [
    () => findFirstVisibleLocator(page, ["[contenteditable='true']", ".ProseMirror"]),
    () => findFirstVisibleText(page, ["生成图片"])
  ]);

  if (!(await isRednoteFinalEditor(page))) {
    const bodyLocator = await findFirstVisibleLocator(page, ["[contenteditable='true']", ".ProseMirror"]);
    if (bodyLocator) await fillText(page, bodyLocator, `${title}\n\n${body}`);
    await clickFirstText(page, ["生成图片"]);
    await waitUntil(
      async () =>
        (await isRednoteFinalEditor(page)) ||
        (await findFirstVisibleText(page, ["下一步", "发布"])) !== null ||
        (await clickFirstGeneratedImage(page)),
      45000,
      1000
    );
  }

  if (!(await isRednoteFinalEditor(page))) {
    await clickFirstGeneratedImage(page);
    await clickFirstText(page, ["下一步"]);
    await waitUntil(() => isRednoteFinalEditor(page), 20000);
  }
}

export function createRednoteBrowserPublisher(options: RednoteBrowserPublisherOptions = {}): RednoteBrowserPublisher {
  function resetPersistentPage(): void {
    persistentPage = null;
    persistentPagePromise = null;
    managedBrowserPromise = null;
  }

  async function getPage(): Promise<RednoteBrowserPage> {
    if (options.openPage) return wrapPage(await options.openPage());
    if (persistentPage) {
      try {
        if (!persistentPage.isClosed()) return persistentPage;
      } catch {
        resetPersistentPage();
      }
    }
    if (!persistentPagePromise) persistentPagePromise = ensurePersistentPage(options);
    persistentPage = await persistentPagePromise;
    return persistentPage;
  }

  return {
    async openLoginPage() {
      const page = await getPage();
      await gotoAndIgnoreAbort(page, rednoteLoginUrl);
      await page.waitForLoadState("domcontentloaded");
      await page.bringToFront?.();
      activateChromeWindow();
      return { url: page.url(), connected: !(await isRednoteLoginRequired(page)) };
    },

    async checkLoginStatus() {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const page = await getPage();
          await gotoAndIgnoreAbort(page, "https://creator.xiaohongshu.com/");
          await page.waitForLoadState("domcontentloaded");
          if (await isRednoteLoginRequired(page)) {
            return { connected: false, url: page.url() };
          }
          return { connected: !(await isRednoteLoginRequired(page)), url: page.url() };
        } catch (error) {
          resetPersistentPage();
          if (!isClosedBrowserError(error) || attempt === 1) throw error;
        }
      }
      return { connected: false };
    },

    async publish(draft: RednotePublishDraft) {
      let page: RednoteBrowserPage | null = null;
      let openError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const currentPage = await getPage();
          page = currentPage;
          if (!(await isRednotePublishPageReady(currentPage))) {
            await gotoAndIgnoreAbort(currentPage, rednotePublishUrl);
            await currentPage.waitForLoadState("domcontentloaded");
          }
          await waitForAnyVisible(currentPage, [() => findFirstVisibleText(currentPage, ["上传图文"])], 10000);
          await new Promise((resolve) => setTimeout(resolve, 800));
          await runRednoteTextToImageFlow(currentPage, draft.title, draft.body);
          await currentPage.bringToFront?.();
          activateChromeWindow();
          break;
        } catch (error) {
          openError = error;
          resetPersistentPage();
        }
      }
      if (!page) {
        const message = openError instanceof Error ? openError.message : String(openError);
        return {
          status: "NEEDS_LOGIN",
          message: message.includes("closed") ? "小红书登录窗口已关闭，请重新打开平台登录页" : "小红书页面打开失败，请重新登录后再发布"
        };
      }

      if (await isRednoteLoginRequired(page)) {
        return {
          status: "NEEDS_LOGIN",
          message: "请先在已打开的小红书登录页完成登录，再重新点击发布"
        };
      }
      const filledMode = await fillRednoteForm(page, draft.title, draft.body);
      if (!filledMode) {
        return {
          status: "NEEDS_USER_ACTION",
          message: "已打开小红书发布页，但没有找到最终标题和正文编辑区，请确认文字配图已生成后再发布"
        };
      }
      if (filledMode === "TEXT_TO_IMAGE") {
        return {
          status: "NEEDS_USER_ACTION",
          message: "小红书文字配图内容已填入，请点击生成图片并进入下一步后继续完成发布",
          publishedUrl: page.url()
        };
      }
      await clickFirstText(page, ["发布"]);
      return {
        status: "SUCCESS",
        message: "小红书标题和正文已填入并点击发布",
        publishedUrl: page.url()
      };
    }
  };
}

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserLocator, BrowserPage } from "./zhihu-browser.js";

export const bilibiliLoginUrl = "https://passport.bilibili.com/login";
export const bilibiliDynamicUrl = "https://t.bilibili.com/";

export interface BilibiliPublishDraft {
  title: string;
  body: string;
  tags: string[];
  images: Array<{ name: string; url: string; type?: string }>;
}

export interface BilibiliBrowserPublisher {
  openLoginPage(): Promise<{ url: string; connected?: boolean }>;
  checkLoginStatus(): Promise<{ connected: boolean; url?: string }>;
  publish(draft: BilibiliPublishDraft): Promise<{
    status: "SUCCESS" | "NEEDS_LOGIN" | "NEEDS_USER_ACTION";
    message: string;
    publishedUrl?: string;
  }>;
}

interface BilibiliBrowserPage extends BrowserPage {
  evaluate?<T>(pageFunction: (arg: string) => T, arg: string): Promise<T>;
}

export interface BilibiliBrowserPublisherOptions {
  openPage?: () => Promise<BilibiliBrowserPage>;
  openUserPage?: () => Promise<BilibiliBrowserPage | null>;
  executablePath?: string;
  headless?: boolean;
}

const defaultChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const managedRemoteDebuggingPort = Number(process.env.CONTENTFLOW_BILIBILI_BROWSER_PORT ?? process.env.CONTENTFLOW_BROWSER_PORT ?? 9222);
const managedProfileDir =
  process.env.CONTENTFLOW_BILIBILI_BROWSER_PROFILE_DIR ??
  process.env.CONTENTFLOW_BROWSER_PROFILE_DIR ??
  resolve(process.cwd(), "../../.contentflow-browser/shared-managed");

let persistentPage: BilibiliBrowserPage | null = null;
let persistentPagePromise: Promise<BilibiliBrowserPage> | null = null;
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

function wrapPage(page: any): BilibiliBrowserPage {
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
  throw new Error(`无法连接到 B站浏览器调试端口 ${port}`);
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

async function ensureManagedPage(browser: any): Promise<BilibiliBrowserPage> {
  const contexts = browser.contexts();
  const context = contexts[0] ?? (await browser.newContext());
  const pages = context.pages();
  const bilibiliPage = pages.find((page: any) => {
    const url = typeof page.url === "function" ? page.url() : "";
    return url.includes("bilibili.com");
  });
  return wrapPage(bilibiliPage ?? (await context.newPage()));
}

async function ensurePersistentPage(options: BilibiliBrowserPublisherOptions): Promise<BilibiliBrowserPage> {
  if (options.openPage) return wrapPage(await options.openPage());

  const { chromium } = await import("playwright-core");
  const executablePath = options.executablePath ?? process.env.CONTENTFLOW_CHROME_PATH ?? defaultChromePath;
  const headless = options.headless ?? false;
  const browser = await ensureManagedBrowser(chromium, executablePath, headless);
  return ensureManagedPage(browser);
}

async function findUserBilibiliPage(): Promise<BilibiliBrowserPage | null> {
  const { chromium } = await import("playwright-core");
  const port = Number(process.env.CONTENTFLOW_BROWSER_PORT ?? 9222);
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const pages = browser.contexts().flatMap((context: any) => context.pages());
    const bilibiliPages = pages.filter((page: any) => {
      const url = typeof page.url === "function" ? page.url() : "";
      return url.includes("bilibili.com") && !url.includes("passport.bilibili.com");
    });
    return bilibiliPages[0] ? wrapPage(bilibiliPages[0]) : null;
  } catch {
    return null;
  }
}

async function gotoAndIgnoreAbort(page: BrowserPage, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ERR_ABORTED")) {
      throw error;
    }
  }
}

async function findFirstVisibleLocator(page: BrowserPage, selectors: string[]): Promise<BrowserLocator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if ((await locator.count()) > 0 && (await locator.first().isVisible())) {
      return locator.first();
    }
  }
  return null;
}

async function findFirstVisiblePlaceholder(page: BrowserPage, placeholders: string[]): Promise<BrowserLocator | null> {
  for (const placeholder of placeholders) {
    const locator = page.getByPlaceholder(placeholder, { exact: false });
    if ((await locator.count()) > 0 && (await locator.first().isVisible())) {
      return locator.first();
    }
  }
  return null;
}

async function findFirstVisibleText(page: BrowserPage, texts: string[]): Promise<BrowserLocator | null> {
  for (const text of texts) {
    const locator = page.getByText(text, { exact: false });
    if ((await locator.count()) > 0 && (await locator.first().isVisible())) {
      return locator.first();
    }
  }
  return null;
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

async function isBilibiliLoginRequired(page: BrowserPage): Promise<boolean> {
  const currentUrl = page.url();
  if (currentUrl.includes("passport.bilibili.com") || currentUrl.includes("/login")) return true;
  if (
    (await findFirstVisibleLocator(page, [
      ".go-login-btn",
      ".header-login-entry",
      ".login-panel-popover .login-btn",
      ".bili-dyn-login-register__login-btn"
    ])) !== null
  ) {
    return true;
  }
  return (await findFirstVisibleText(page, ["登录", "立即登录", "扫码登录", "密码登录"])) !== null;
}

async function fillBilibiliEditor(page: BilibiliBrowserPage, body: string): Promise<boolean> {
  async function fillEditor(locator: BrowserLocator): Promise<void> {
    await locator.click();
    if (page.evaluate) {
      await page.evaluate((text) => {
        const doc = (globalThis as any).document;
        const element = doc.activeElement;
        if (!element) return false;
        const editable = element.closest("[contenteditable='true']") ?? element;
        if (editable.tagName === "TEXTAREA" || editable.tagName === "INPUT") {
          editable.value = text;
          editable.dispatchEvent(new Event("input", { bubbles: true }));
          editable.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        if (editable.nodeType === 1) {
          editable.textContent = "";
          editable.dispatchEvent(new (globalThis as any).InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: text }));
          doc.execCommand("insertText", false, text);
          editable.dispatchEvent(new (globalThis as any).InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
          return true;
        }
        return false;
      }, body);
      return;
    }
    if (page.keyboard) {
      await page.keyboard.press("Meta+A");
      await page.keyboard.type(body);
      return;
    }
    await locator.fill(body);
  }

  const placeholder = await findFirstVisiblePlaceholder(page, ["说点什么", "发一条友善的动态", "分享你的动态"]);
  if (placeholder) {
    await fillEditor(placeholder);
    return true;
  }

  const locator = await findFirstVisibleLocator(page, [
    "textarea[placeholder*='动态']",
    "textarea[placeholder*='说点']",
    "div[contenteditable='true']",
    "[contenteditable='true']",
    ".ql-editor",
    ".ProseMirror",
    "[class*='editor']"
  ]);
  if (!locator) return false;
  await fillEditor(locator);
  return true;
}

async function fillBilibiliTitle(page: BilibiliBrowserPage, title: string): Promise<boolean> {
  async function fillTitle(locator: BrowserLocator): Promise<void> {
    await locator.click();
    if (page.evaluate) {
      await page.evaluate((text) => {
        const doc = (globalThis as any).document;
        const element = doc.activeElement;
        if (!element) return false;
        const editable = element.closest("[contenteditable='true']") ?? element;
        if (editable.tagName === "TEXTAREA" || editable.tagName === "INPUT") {
          editable.value = text;
          editable.dispatchEvent(new Event("input", { bubbles: true }));
          editable.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        if (editable.nodeType === 1) {
          editable.textContent = "";
          editable.dispatchEvent(new (globalThis as any).InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: text }));
          doc.execCommand("insertText", false, text);
          editable.dispatchEvent(new (globalThis as any).InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
          return true;
        }
        return false;
      }, title);
      return;
    }
    if (page.keyboard) {
      await page.keyboard.press("Meta+A");
      await page.keyboard.type(title);
      return;
    }
    await locator.fill(title);
  }

  const placeholder = await findFirstVisiblePlaceholder(page, ["好的标题更容易获得支持", "选填20字", "标题"]);
  if (placeholder) {
    await fillTitle(placeholder);
    return true;
  }

  const locator = await findFirstVisibleLocator(page, [
    "input[placeholder*='标题']",
    "textarea[placeholder*='标题']",
    "[placeholder*='标题']",
    "[data-placeholder*='标题']",
    "[aria-placeholder*='标题']",
    "[contenteditable='true'][data-placeholder*='标题']",
    "[contenteditable='true'][aria-placeholder*='标题']"
  ]);
  if (!locator) return false;
  await fillTitle(locator);
  return true;
}

export function createBilibiliBrowserPublisher(options: BilibiliBrowserPublisherOptions = {}): BilibiliBrowserPublisher {
  function resetPersistentPage(): void {
    persistentPage = null;
    persistentPagePromise = null;
  }

  async function getPage(): Promise<BilibiliBrowserPage> {
    if (options.openPage) return wrapPage(await options.openPage());
    if (persistentPage) {
      try {
        if (!persistentPage.isClosed()) return persistentPage;
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

  async function getAuthenticatedUserPage(): Promise<BilibiliBrowserPage | null> {
    const page = options.openUserPage ? await options.openUserPage() : await findUserBilibiliPage();
    if (!page) return null;
    const wrappedPage = wrapPage(page);
    if (await isBilibiliLoginRequired(wrappedPage)) return null;
    return wrappedPage;
  }

  return {
    async openLoginPage() {
      const page = await getPage();
      await gotoAndIgnoreAbort(page, bilibiliDynamicUrl);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await waitForAnyVisible(page, [
        () => findFirstVisibleLocator(page, [".go-login-btn", ".bili-dyn-login-register__login-btn"]),
        () => findFirstVisiblePlaceholder(page, ["说点什么", "发一条友善的动态", "分享你的动态"]),
        () => findFirstVisibleLocator(page, ["div[contenteditable='true']", "[contenteditable='true']", ".ql-editor", ".ProseMirror"])
      ]).catch(() => undefined);
      if (await isBilibiliLoginRequired(page)) {
        await gotoAndIgnoreAbort(page, bilibiliLoginUrl);
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      }
      await page.bringToFront?.();
      activateChromeWindow();
      return { url: page.url(), connected: !(await isBilibiliLoginRequired(page)) };
    },

    async checkLoginStatus() {
      const page = (await getAuthenticatedUserPage()) ?? (await getPage());
      await gotoAndIgnoreAbort(page, bilibiliDynamicUrl);
      await page.waitForLoadState("domcontentloaded");
      await waitForAnyVisible(page, [
        () => findFirstVisibleLocator(page, [".go-login-btn", ".bili-dyn-login-register__login-btn"]),
        () => findFirstVisiblePlaceholder(page, ["说点什么", "发一条友善的动态", "分享你的动态"]),
        () => findFirstVisibleLocator(page, ["div[contenteditable='true']", "[contenteditable='true']", ".ql-editor", ".ProseMirror"])
      ]);
      return { connected: !(await isBilibiliLoginRequired(page)), url: page.url() };
    },

    async publish(draft: BilibiliPublishDraft) {
      let page: BilibiliBrowserPage;
      try {
        page = (await getAuthenticatedUserPage()) ?? (await getPage());
        await gotoAndIgnoreAbort(page, bilibiliDynamicUrl);
        await page.waitForLoadState("domcontentloaded");
        await waitForAnyVisible(page, [
          () => findFirstVisibleLocator(page, [".go-login-btn", ".bili-dyn-login-register__login-btn"]),
          () => findFirstVisiblePlaceholder(page, ["说点什么", "发一条友善的动态", "分享你的动态"]),
          () => findFirstVisibleLocator(page, ["div[contenteditable='true']", "[contenteditable='true']", ".ql-editor", ".ProseMirror"])
        ]);
        await page.bringToFront?.();
        activateChromeWindow();
      } catch (error) {
        resetPersistentPage();
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "NEEDS_LOGIN",
          message: message.includes("closed") ? "B站登录窗口已关闭，请重新打开平台登录页" : "B站页面打开失败，请重新登录后再发布"
        };
      }

      if (await isBilibiliLoginRequired(page)) {
        return {
          status: "NEEDS_LOGIN",
          message: "请先在已打开的 B站登录页完成登录，再重新点击发布"
        };
      }

      const titleFilled = await fillBilibiliTitle(page, draft.title);

      if (!(await fillBilibiliEditor(page, draft.body))) {
        if (await isBilibiliLoginRequired(page)) {
          return {
            status: "NEEDS_LOGIN",
            message: "请先在已打开的 B站登录页完成登录，再重新点击发布"
          };
        }
        return {
          status: "NEEDS_USER_ACTION",
          message: "没有找到 B站动态编辑区"
        };
      }

      return {
        status: "NEEDS_USER_ACTION",
        message: titleFilled ? "B站动态标题和内容已填入，请确认内容后手动发布" : "B站动态内容已填入，但没有找到标题输入框，请手动补充标题后发布",
        publishedUrl: page.url()
      };
    }
  };
}

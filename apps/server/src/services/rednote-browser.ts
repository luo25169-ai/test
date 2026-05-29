import { spawn } from "node:child_process";
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
  throw new Error(`无法连接到小红书浏览器调试端口 ${port}`);
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
          "--disable-popup-blocking",
          "--disable-infobars",
          "--enable-unsafe-swiftshader",
          headless ? "--headless=new" : "--start-maximized"
        ].filter(Boolean),
        { detached: true, stdio: "ignore" }
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

async function ensureManagedPage(browser: any): Promise<RednoteBrowserPage> {
  const contexts = browser.contexts();
  const context = contexts[0] ?? (await browser.newContext());
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

async function waitForAnyVisible(page: BrowserPage, checks: Array<() => Promise<BrowserLocator | null>>, timeoutMs = 8000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const check of checks) {
      if (await check()) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function isRednoteLoginRequired(page: BrowserPage): Promise<boolean> {
  const currentUrl = page.url();
  if (currentUrl.includes("/login")) return true;
  if ((await findFirstVisibleLocator(page, ["[class*='login']", ".login-container", ".login-panel"])) !== null) return true;
  return (await findFirstVisibleText(page, ["登录", "扫码登录", "手机号登录"])) !== null;
}

async function fillText(page: RednoteBrowserPage, locator: BrowserLocator, value: string): Promise<void> {
  await locator.click();
  if (page.keyboard) {
    await page.keyboard.press("Meta+A");
  }
  await locator.fill(value);
}

async function fillRednoteForm(page: RednoteBrowserPage, title: string, body: string): Promise<boolean> {
  const titleLocator =
    (await findFirstVisiblePlaceholder(page, ["填写标题", "请输入标题", "标题"])) ??
    (await findFirstVisibleLocator(page, ["input[placeholder*='标题']", "textarea[placeholder*='标题']", "[class*='title'] input"]));
  const bodyLocator =
    (await findFirstVisiblePlaceholder(page, ["填写正文", "输入正文", "添加正文", "描述", "分享"])) ??
    (await findFirstVisibleLocator(page, ["textarea[placeholder*='正文']", "textarea[placeholder*='描述']", "[contenteditable='true']", "[class*='editor']"]));
  if (!titleLocator || !bodyLocator) return false;
  await fillText(page, titleLocator, title);
  await fillText(page, bodyLocator, body);
  return true;
}

export function createRednoteBrowserPublisher(options: RednoteBrowserPublisherOptions = {}): RednoteBrowserPublisher {
  function resetPersistentPage(): void {
    persistentPage = null;
    persistentPagePromise = null;
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
      const page = await getPage();
      await gotoAndIgnoreAbort(page, "https://creator.xiaohongshu.com/");
      await page.waitForLoadState("domcontentloaded");
      if (await isRednoteLoginRequired(page)) {
        return { connected: false, url: page.url() };
      }
      return { connected: !(await isRednoteLoginRequired(page)), url: page.url() };
    },

    async publish(draft: RednotePublishDraft) {
      let page: RednoteBrowserPage;
      try {
        page = await getPage();
        await gotoAndIgnoreAbort(page, rednotePublishUrl);
        await page.waitForLoadState("domcontentloaded");
        await waitForAnyVisible(page, [
          () => findFirstVisiblePlaceholder(page, ["填写标题", "请输入标题", "标题"]),
          () => findFirstVisibleLocator(page, ["[class*='login']", ".login-container", ".login-panel"])
        ]);
        await page.bringToFront?.();
        activateChromeWindow();
      } catch (error) {
        resetPersistentPage();
        const message = error instanceof Error ? error.message : String(error);
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
      if (!(await fillRednoteForm(page, draft.title, draft.body))) {
        return {
          status: "NEEDS_USER_ACTION",
          message: "没有找到小红书笔记编辑区"
        };
      }
      return {
        status: "NEEDS_USER_ACTION",
        message: "小红书笔记内容已填入，请上传图片并确认后手动发布",
        publishedUrl: page.url()
      };
    }
  };
}

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
}

export interface WechatBrowserPublisher {
  openLoginPage(): Promise<{ url: string }>;
  publish(draft: WechatPublishDraft): Promise<{
    status: "SUCCESS" | "NEEDS_LOGIN" | "NEEDS_USER_ACTION";
    message: string;
    publishedUrl?: string;
  }>;
}

export interface WechatBrowserPublisherOptions {
  openPage?: () => Promise<WechatBrowserPage>;
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
    isClosed() {
      return typeof page.isClosed === "function" ? page.isClosed() : false;
    },
    async bringToFront() {
      if (typeof page.bringToFront === "function") {
        await page.bringToFront();
      }
    }
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
  return wrapPage(pages[0] ?? (await context.newPage()));
}

async function ensurePersistentPage(options: WechatBrowserPublisherOptions): Promise<WechatBrowserPage> {
  if (options.openPage) return wrapPage(await options.openPage());

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
  const locator = await findFirstVisibleLocator(root, selectors);
  if (!locator) return false;
  await locator.fill(value);
  return true;
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

async function fillWechatBody(page: WechatBrowserPage, body: string): Promise<boolean> {
  const bodySelectors = [
    "#ueditor_0 body",
    "body[contenteditable='true']",
    "body",
    "[contenteditable='true']",
    ".ProseMirror",
    ".ql-editor",
    "#js_editor",
    ".editor"
  ];

  if (await fillFirstVisible(page, bodySelectors, body)) return true;

  if (!page.frameLocator) return false;
  for (const frameSelector of ["iframe#ueditor_0", "iframe[id*='ueditor']", "iframe[id*='editor']", "iframe"]) {
    const frame = page.frameLocator(frameSelector);
    if (await fillFirstVisible(frame, bodySelectors, body)) return true;
  }
  return false;
}

export function createWechatBrowserPublisher(options: WechatBrowserPublisherOptions = {}): WechatBrowserPublisher {
  async function getPage(): Promise<WechatBrowserPage> {
    if (options.openPage) return wrapPage(await options.openPage());
    if (persistentPage && !persistentPage.isClosed()) return persistentPage;
    if (!persistentPagePromise) {
      persistentPagePromise = ensurePersistentPage(options);
    }
    persistentPage = await persistentPagePromise;
    return persistentPage;
  }

  return {
    async openLoginPage() {
      const page = await getPage();
      await gotoAndIgnoreAbort(page, wechatLoginUrl);
      await page.waitForLoadState("domcontentloaded");
      await page.bringToFront?.();
      activateChromeWindow();
      return { url: wechatLoginUrl };
    },

    async publish(draft: WechatPublishDraft) {
      const page = await getPage();
      await gotoAndIgnoreAbort(page, wechatArticleEditUrl);
      await page.waitForLoadState("domcontentloaded");
      await page.bringToFront?.();
      activateChromeWindow();

      if (await isWechatLoginRequired(page)) {
        return {
          status: "NEEDS_LOGIN",
          message: "请先在已打开的公众号页面完成登录，再重新点击发布"
        };
      }

      const titleFilled = await fillFirstVisible(
        page,
        [
          "input[placeholder*='标题']",
          "textarea[placeholder*='标题']",
          "[contenteditable='true'][data-placeholder*='标题']",
          "[contenteditable='true'][aria-label*='标题']",
          "[id*='title']",
          "[class*='title']"
        ],
        draft.title
      );
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

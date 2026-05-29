import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export const zhihuLoginUrl = "https://www.zhihu.com/signin";
export const zhihuArticleWriteUrl = "https://zhuanlan.zhihu.com/write";

export interface ZhihuPublishDraft {
  title: string;
  body: string;
  tags: string[];
  images: Array<{ name: string; url: string; type?: string }>;
}

export interface BrowserLocator {
  count(): Promise<number>;
  first(): BrowserLocator;
  fill(value: string): Promise<void>;
  click(): Promise<void>;
  isVisible(): Promise<boolean>;
}

export interface BrowserPage {
  goto(url: string, options?: { waitUntil?: "domcontentloaded" | "load" | "networkidle" }): Promise<void>;
  waitForLoadState(state: "domcontentloaded" | "load" | "networkidle"): Promise<void>;
  url(): string;
  locator(selector: string): BrowserLocator;
  getByText(text: string, options?: { exact?: boolean }): BrowserLocator;
  isClosed(): boolean;
}

export interface ZhihuBrowserPublisher {
  openLoginPage(): Promise<{ url: string }>;
  publish(draft: ZhihuPublishDraft): Promise<{
    status: "SUCCESS" | "NEEDS_LOGIN" | "NEEDS_USER_ACTION";
    message: string;
    publishedUrl?: string;
  }>;
}

export interface ZhihuBrowserPublisherOptions {
  openPage?: () => Promise<BrowserPage>;
  executablePath?: string;
  profileDir?: string;
  headless?: boolean;
}

const defaultProfileDir = resolve(process.cwd(), "../../.contentflow-browser/zhihu");
const defaultChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function ensurePersistentPage(options: ZhihuBrowserPublisherOptions): Promise<BrowserPage> {
  if (options.openPage) return wrapPage(await options.openPage());

  const { chromium } = await import("playwright-core");
  const executablePath = options.executablePath ?? process.env.CONTENTFLOW_CHROME_PATH ?? defaultChromePath;
  const profileDir = options.profileDir ?? process.env.CONTENTFLOW_BROWSER_PROFILE_DIR ?? defaultProfileDir;
  const headless = options.headless ?? false;

  await mkdir(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless,
    viewport: null
  });
  const pages = context.pages();
  const page = wrapPage(pages[0] ?? (await context.newPage()));
  persistentContext = context;
  persistentPage = page;
  return page;
}

let persistentContext: any | null = null;
let persistentPage: BrowserPage | null = null;

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

function wrapPage(page: any): BrowserPage {
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
    getByText(text: string, options?: { exact?: boolean }) {
      return wrapLocator(page.getByText(text, options));
    },
    isClosed() {
      return typeof page.isClosed === "function" ? page.isClosed() : false;
    }
  };
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

async function findFirstVisibleText(page: BrowserPage, texts: string[]): Promise<BrowserLocator | null> {
  for (const text of texts) {
    const locator = page.getByText(text, { exact: true });
    if ((await locator.count()) > 0 && (await locator.first().isVisible())) {
      return locator.first();
    }
  }
  return null;
}

async function isZhihuLoginPage(page: BrowserPage): Promise<boolean> {
  const currentUrl = page.url();
  if (currentUrl.includes("/signin")) return true;
  return (await findFirstVisibleText(page, ["验证码登录", "密码登录", "登录/注册"])) !== null;
}

async function fillEditorField(page: BrowserPage, selectors: string[], value: string): Promise<boolean> {
  const locator = await findFirstVisibleLocator(page, selectors);
  if (!locator) return false;
  await locator.fill(value);
  return true;
}

async function clickButton(page: BrowserPage, labels: string[]): Promise<boolean> {
  const locator = await findFirstVisibleText(page, labels);
  if (!locator) return false;
  await locator.click();
  return true;
}

export function createZhihuBrowserPublisher(options: ZhihuBrowserPublisherOptions = {}): ZhihuBrowserPublisher {
  let persistentPagePromise: Promise<BrowserPage> | null = null;

  async function getPage(): Promise<BrowserPage> {
    if (options.openPage) {
      return wrapPage(await options.openPage());
    }
    if (persistentPage && !persistentPage.isClosed()) {
      return persistentPage;
    }
    if (!persistentPagePromise) {
      persistentPagePromise = ensurePersistentPage(options);
    }
    const page = await persistentPagePromise;
    persistentPage = page;
    return page;
  }

  return {
    async openLoginPage() {
      const page = await getPage();
      await page.goto(zhihuLoginUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("domcontentloaded");
      return { url: zhihuLoginUrl };
    },

    async publish(draft: ZhihuPublishDraft) {
      const page = await getPage();
      await page.goto(zhihuArticleWriteUrl, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("domcontentloaded");

      if (await isZhihuLoginPage(page)) {
        return {
          status: "NEEDS_LOGIN",
          message: "请先在已打开的知乎登录页完成登录，再重新点击发布"
        };
      }

      const titleFilled = await fillEditorField(page, [
        'textarea[placeholder*="标题"]',
        'input[placeholder*="标题"]',
        'textarea[placeholder*="写标题"]',
        'input[placeholder*="写标题"]'
      ], draft.title);
      if (!titleFilled) {
        return {
          status: "NEEDS_USER_ACTION",
          message: "没有找到知乎标题输入框"
        };
      }

      const bodyFilled = await fillEditorField(page, [
        'textarea[placeholder*="正文"]',
        'textarea[placeholder*="内容"]',
        'div[contenteditable="true"]',
        'textarea'
      ], draft.body);
      if (!bodyFilled) {
        return {
          status: "NEEDS_USER_ACTION",
          message: "没有找到知乎正文编辑区"
        };
      }

      const clickedPublish = await clickButton(page, ["发布", "发表"]);
      if (!clickedPublish) {
        return {
          status: "NEEDS_USER_ACTION",
          message: "没有找到知乎发布按钮"
        };
      }

      await clickButton(page, ["确认发布", "确定"]);
      return {
        status: "SUCCESS",
        message: "知乎文章已提交发布",
        publishedUrl: page.url()
      };
    }
  };
}

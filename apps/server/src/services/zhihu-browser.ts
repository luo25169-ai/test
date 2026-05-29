import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
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
  getByPlaceholder(text: string, options?: { exact?: boolean }): BrowserLocator;
  getByText(text: string, options?: { exact?: boolean }): BrowserLocator;
  evaluate?<T>(pageFunction: (arg: any) => T, arg: any): Promise<T>;
  isClosed(): boolean;
  bringToFront?(): Promise<void>;
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

function activateChromeWindow(): void {
  try {
    execFileSync("osascript", ["-e", 'tell application "Google Chrome" to activate'], {
      stdio: "ignore"
    });
  } catch {
    // Best effort only. If activation fails, the login window may still be open in Chrome.
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
    getByPlaceholder(text: string, options?: { exact?: boolean }) {
      return wrapLocator(page.getByPlaceholder(text, options));
    },
    getByText(text: string, options?: { exact?: boolean }) {
      return wrapLocator(page.getByText(text, options));
    },
    evaluate<T>(pageFunction: (arg: any) => T, arg: any) {
      if (typeof page.evaluate !== "function") {
        return Promise.reject(new Error("page.evaluate is not available"));
      }
      return page.evaluate(pageFunction, arg);
    },
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

async function findFirstVisiblePlaceholder(page: BrowserPage, placeholders: string[]): Promise<BrowserLocator | null> {
  for (const placeholder of placeholders) {
    const locator = page.getByPlaceholder(placeholder, { exact: false });
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

async function fillEditorFieldByPlaceholder(page: BrowserPage, placeholders: string[], value: string): Promise<boolean> {
  const locator = await findFirstVisiblePlaceholder(page, placeholders);
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

async function fillEditorFieldByEvaluation(page: BrowserPage, kind: "title" | "body", value: string): Promise<boolean> {
  if (typeof page.evaluate !== "function") return false;
  return page.evaluate(
    ({ kind, value }) => {
      const g = globalThis as any;
      const d = g.document as any;
      const w = g.window ?? g;
      const isVisible = (element: any) => {
        const style = w.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };

      const wantedText = kind === "title" ? ["请输入标题", "标题"] : ["请输入正文", "正文", "内容"];
      const selectors =
        kind === "title"
          ? [
              'h1[contenteditable="true"]',
              'div[contenteditable="true"][data-placeholder*="标题"]',
              'div[contenteditable="true"][placeholder*="标题"]',
              'div[contenteditable="true"][aria-label*="标题"]',
              'div[contenteditable="true"][role="textbox"]',
              'textarea[placeholder*="标题"]',
              'input[placeholder*="标题"]',
              '.WriteIndex-titleInput textarea',
              '.WriteIndex-titleInput input'
            ]
          : [
              ".public-DraftEditor-content",
              '[data-slate-editor="true"]',
              "[data-slate-editor]",
              'div[contenteditable="true"]',
              'textarea[placeholder*="正文"]',
              'textarea[placeholder*="内容"]',
              "textarea"
            ];

      const candidates: any[] = [];
      const pushCandidate = (element: any | null) => {
        if (!element || !isVisible(element)) return;
        if (!candidates.includes(element)) candidates.push(element);
      };

      for (const selector of selectors) {
        d.querySelectorAll(selector).forEach(pushCandidate);
      }

      if (!candidates.length) {
        d.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"], h1, h2, h3, div, p').forEach((element: any) => {
          if (!isVisible(element)) return;
          const haystack = [
            element.getAttribute("placeholder"),
            element.getAttribute("aria-label"),
            element.getAttribute("data-placeholder"),
            element.getAttribute("title"),
            element.textContent,
            element.innerText
          ]
            .filter(Boolean)
            .join(" ");
          if (wantedText.some((text) => haystack.includes(text))) {
            pushCandidate(element);
          }
        });
      }

      if (!candidates.length) return false;

      const score = (element: any) => {
        const rect = element.getBoundingClientRect();
        const haystack = [
          element.getAttribute("placeholder"),
          element.getAttribute("aria-label"),
          element.getAttribute("data-placeholder"),
          element.getAttribute("title"),
          element.textContent,
          element.innerText
        ]
          .filter(Boolean)
          .join(" ");
        let valueScore = 0;
        if (kind === "title") {
          if (haystack.includes("标题")) valueScore += 100;
          if (element.tagName === "H1") valueScore += 80;
          if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") valueScore += 60;
          if (element.isContentEditable) valueScore += 40;
          if (rect.height < 220) valueScore += 20;
          valueScore -= rect.top / 10;
        } else {
          if (haystack.includes("正文") || haystack.includes("内容")) valueScore += 100;
          if (element.isContentEditable) valueScore += 70;
          if (element.tagName === "TEXTAREA") valueScore += 50;
          valueScore += Math.min(rect.height, 1000) / 10;
          valueScore -= rect.top / 20;
        }
        return valueScore;
      };

      const target = [...candidates].sort((a, b) => score(b) - score(a))[0];
      if (!target) return false;

      target.focus();
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
        const proto = Object.getPrototypeOf(target);
        const valueDescriptor = Object.getOwnPropertyDescriptor(proto, "value");
        if (valueDescriptor?.set) {
          valueDescriptor.set.call(target, value);
        } else {
          target.value = value;
        }
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }

      if (target.isContentEditable) {
        const selection = g.getSelection();
        const range = d.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
        const inserted = d.execCommand("insertText", false, value);
        if (!inserted) {
          target.textContent = value;
          target.dispatchEvent(new w.InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
        }
        return true;
      }

      return false;
    },
    { kind, value }
  );
}

async function clickButtonByEvaluation(page: BrowserPage, labels: string[]): Promise<boolean> {
  if (typeof page.evaluate !== "function") return false;
  return page.evaluate(
    ({ labels }) => {
      const g = globalThis as any;
      const d = g.document as any;
      const w = g.window ?? g;
      const isVisible = (element: any) => {
        const style = w.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };

      const candidates = Array.from(d.querySelectorAll('button, [role="button"], a, div, span')).filter((element: any) => {
        if (!isVisible(element)) return false;
        const haystack = [
          element.textContent,
          element.innerText,
          element.getAttribute("aria-label"),
          element.getAttribute("title")
        ]
          .filter(Boolean)
          .join(" ");
        return labels.some((label: string) => haystack.includes(label));
      }) as any[];

      const target = candidates[0];
      if (!target) return false;
      target.click();
      return true;
    },
    { labels }
  );
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
    if (persistentPage && persistentPage.isClosed()) {
      persistentPage = null;
      persistentPagePromise = null;
      persistentContext = null;
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
      try {
        const page = await getPage();
        await page.goto(zhihuLoginUrl, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("domcontentloaded");
        await page.bringToFront?.();
        activateChromeWindow();
        return { url: zhihuLoginUrl };
      } catch (error) {
        persistentPage = null;
        persistentPagePromise = null;
        persistentContext = null;
        throw error;
      }
    },

    async publish(draft: ZhihuPublishDraft) {
      const page = await getPage();
      try {
        await page.goto(zhihuArticleWriteUrl, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("domcontentloaded");
        await page.bringToFront?.();
        activateChromeWindow();
      } catch (error) {
        persistentPage = null;
        persistentPagePromise = null;
        persistentContext = null;
        throw error;
      }

      if (await isZhihuLoginPage(page)) {
        return {
          status: "NEEDS_LOGIN",
          message: "请先在已打开的知乎登录页完成登录，再重新点击发布"
        };
      }

      const titleFilled =
        (await fillEditorFieldByPlaceholder(page, ["请输入标题", "标题"], draft.title)) ||
        (await fillEditorField(page, [
          'h1[contenteditable="true"]',
          'div[contenteditable="true"][data-placeholder*="标题"]',
          'div[contenteditable="true"][placeholder*="标题"]',
          'div[contenteditable="true"][aria-label*="标题"]',
          'div[contenteditable="true"][role="textbox"]',
          'textarea[placeholder*="请输入标题"]',
          'input[placeholder*="请输入标题"]',
          'textarea[placeholder*="标题"]',
          'input[placeholder*="标题"]',
          ".WriteIndex-titleInput textarea",
          ".WriteIndex-titleInput input"
        ], draft.title)) ||
        (await fillEditorFieldByEvaluation(page, "title", draft.title));
      if (!titleFilled) {
        return {
          status: "NEEDS_USER_ACTION",
          message: "没有找到知乎标题输入框"
        };
      }

      const bodyFilled =
        (await fillEditorFieldByPlaceholder(page, ["请输入正文", "正文"], draft.body)) ||
        (await fillEditorField(page, [
          ".public-DraftEditor-content",
          '[data-slate-editor="true"]',
          "[data-slate-editor]",
          'div[contenteditable="true"]',
          'textarea[placeholder*="正文"]',
          'textarea[placeholder*="内容"]',
          'textarea'
        ], draft.body)) ||
        (await fillEditorFieldByEvaluation(page, "body", draft.body));
      if (!bodyFilled) {
        return {
          status: "NEEDS_USER_ACTION",
          message: "没有找到知乎正文编辑区"
        };
      }

      const clickedPublish = (await clickButton(page, ["发布", "发表"])) || (await clickButtonByEvaluation(page, ["发布", "发表"]));
      if (!clickedPublish) {
        return {
          status: "NEEDS_USER_ACTION",
          message: "没有找到知乎发布按钮"
        };
      }

      await clickButton(page, ["确认发布", "确定"]) || (await clickButtonByEvaluation(page, ["确认发布", "确定"]));
      return {
        status: "SUCCESS",
        message: "知乎文章已提交发布",
        publishedUrl: page.url()
      };
    }
  };
}

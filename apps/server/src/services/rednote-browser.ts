import { execFileSync, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserLocator, BrowserPage } from "./zhihu-browser.js";

export const rednoteLoginUrl = "https://creator.xiaohongshu.com/login";
export const rednotePublishUrl = "https://creator.xiaohongshu.com/publish/publish?from=tab_switch&target=image";

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
let cdpClientId = 0;

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

async function ensureRemoteDebuggingBrowser(executablePath: string, headless: boolean): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${managedRemoteDebuggingPort}/json/version`);
    if (response.ok) return;
  } catch {
    // Start a managed Chrome below.
  }

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
}

class CdpClient {
  private socketPromise: Promise<WebSocket>;
  private pending = new Map<number, (value: any) => void>();

  constructor(private readonly websocketUrl: string) {
    this.socketPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(websocketUrl);
      socket.onopen = () => resolve(socket);
      socket.onerror = (event) => reject(event);
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id && this.pending.has(message.id)) {
          this.pending.get(message.id)?.(message);
          this.pending.delete(message.id);
        }
      };
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const socket = await this.socketPromise;
    const id = ++cdpClientId;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }
}

function cdpVisibilityExpression(elementExpression: string): string {
  return `(() => {
    const element = ${elementExpression};
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
      rect.left < innerWidth && rect.top < innerHeight &&
      style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0.01;
  })()`;
}

class CdpLocator implements BrowserLocator {
  constructor(
    private readonly client: CdpClient,
    private readonly expression: string
  ) {}

  async count(): Promise<number> {
    const result = await this.client.send("Runtime.evaluate", {
      expression: `(() => (${this.expression}).length)()`,
      returnByValue: true
    });
    return Number(result.result?.result?.value ?? 0);
  }

  first(): BrowserLocator {
    return new CdpLocator(this.client, `(${this.expression}).slice(0, 1)`);
  }

  async fill(value: string): Promise<void> {
    await this.client.send("Runtime.evaluate", {
      expression: `(() => {
        const element = (${this.expression})[0];
        const text = ${JSON.stringify(value)};
        if (!element) return false;
        element.scrollIntoView?.({ block: "center", inline: "center" });
        element.click?.();
        const editable = element.closest?.("[contenteditable='true']") ?? element;
        if (editable.tagName === "TEXTAREA" || editable.tagName === "INPUT") {
          const prototype = editable.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          if (setter) setter.call(editable, text);
          else editable.value = text;
          editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
          editable.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        if (editable.getAttribute?.("contenteditable") === "true") {
          editable.focus();
          editable.textContent = "";
          editable.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: text }));
          document.execCommand("selectAll", false);
          document.execCommand("insertText", false, text);
          editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
          return true;
        }
        return false;
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
  }

  async click(): Promise<void> {
    await this.client.send("Runtime.evaluate", {
      expression: `(() => {
        const element = (${this.expression})[0];
        if (!element) return false;
        const target = element.closest?.("button, [role='button'], .creator-tab, .d-button, [class*='button']") ?? element;
        target.scrollIntoView?.({ block: "center", inline: "center" });
        for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          target.dispatchEvent(new MouseEvent(eventName, { bubbles: true, cancelable: true, view: window }));
        }
        target.click?.();
        return true;
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
  }

  async isVisible(): Promise<boolean> {
    const result = await this.client.send("Runtime.evaluate", {
      expression: cdpVisibilityExpression(`(${this.expression})[0]`),
      returnByValue: true
    });
    return Boolean(result.result?.result?.value);
  }
}

class CdpRednotePage implements RednoteBrowserPage {
  constructor(
    private readonly client: CdpClient,
    private currentUrl: string
  ) {}

  async goto(url: string): Promise<void> {
    await this.client.send("Page.enable");
    await this.client.send("Page.navigate", { url });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    this.currentUrl = await this.readUrl();
  }

  async waitForLoadState(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    this.currentUrl = await this.readUrl();
  }

  url(): string {
    return this.currentUrl;
  }

  locator(selector: string): BrowserLocator {
    return new CdpLocator(this.client, `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`);
  }

  getByPlaceholder(text: string, options?: { exact?: boolean }): BrowserLocator {
    const matcher = options?.exact
      ? `(element.getAttribute("placeholder") || "") === ${JSON.stringify(text)}`
      : `(element.getAttribute("placeholder") || "").includes(${JSON.stringify(text)})`;
    return new CdpLocator(this.client, `Array.from(document.querySelectorAll("input, textarea, [placeholder]")).filter((element) => ${matcher})`);
  }

  getByText(text: string, options?: { exact?: boolean }): BrowserLocator {
    const matcher = options?.exact
      ? `(element.innerText || element.textContent || "").trim() === ${JSON.stringify(text)}`
      : `(element.innerText || element.textContent || "").includes(${JSON.stringify(text)})`;
    return new CdpLocator(
      this.client,
      `Array.from(document.querySelectorAll("button, [role='button'], .creator-tab, .d-button, div, span, p")).filter((element) => ${matcher})`
    );
  }

  keyboard = {
    type: async (text: string) => {
      await this.client.send("Input.insertText", { text });
    },
    press: async (key: string) => {
      if (key === "Meta+A") {
        await this.client.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 4, key: "a", code: "KeyA" });
        await this.client.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, key: "a", code: "KeyA" });
      }
    }
  };

  mouse = {
    click: async (x: number, y: number) => {
      await this.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await this.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    }
  };

  isClosed(): boolean {
    return false;
  }

  async bringToFront(): Promise<void> {
    await this.client.send("Page.bringToFront");
  }

  async evaluate<T>(pageFunction: (arg: string) => T, arg: string): Promise<T> {
    const browserFunction = pageFunction
      .toString()
      .replace(/\s+as\s+(?:any|string|boolean|number|string\[\]|any\[\])/g, "");
    const result = await this.client.send("Runtime.evaluate", {
      expression: `(${browserFunction})(${JSON.stringify(arg)})`,
      returnByValue: true,
      awaitPromise: true
    });
    return result.result?.result?.value as T;
  }

  private async readUrl(): Promise<string> {
    const result = await this.client.send("Runtime.evaluate", {
      expression: "location.href",
      returnByValue: true
    });
    return String(result.result?.result?.value ?? this.currentUrl);
  }
}

async function createCdpRednotePage(executablePath: string, headless: boolean): Promise<RednoteBrowserPage> {
  await ensureRemoteDebuggingBrowser(executablePath, headless);
  let targets = (await (await fetch(`http://127.0.0.1:${managedRemoteDebuggingPort}/json/list`)).json()) as Array<{
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }>;
  let target = targets.find((item) => item.type === "page" && item.url.includes("creator.xiaohongshu.com"));
  if (!target) {
    await fetch(`http://127.0.0.1:${managedRemoteDebuggingPort}/json/new?${encodeURIComponent(rednotePublishUrl)}`, { method: "PUT" });
    targets = (await (await fetch(`http://127.0.0.1:${managedRemoteDebuggingPort}/json/list`)).json()) as Array<{
      type: string;
      url: string;
      webSocketDebuggerUrl: string;
    }>;
    target = targets.find((item) => item.type === "page" && item.url.includes("creator.xiaohongshu.com")) ?? targets.find((item) => item.type === "page");
  }
  if (!target) throw new Error("没有找到可用的小红书浏览器标签页");
  return new CdpRednotePage(new CdpClient(target.webSocketDebuggerUrl), target.url);
}

async function ensurePersistentPage(options: RednoteBrowserPublisherOptions): Promise<RednoteBrowserPage> {
  if (options.openPage) return wrapPage(await options.openPage());
  const executablePath = options.executablePath ?? process.env.CONTENTFLOW_CHROME_PATH ?? defaultChromePath;
  const headless = options.headless ?? false;
  return createCdpRednotePage(executablePath, headless);
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
    const clicked = await page.evaluate((rawTexts) => {
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
          return true;
        }
      }
      return false;
    }, JSON.stringify(texts));
    if (clicked) return true;
  }
  const locator = await findFirstVisibleText(page, texts);
  if (!locator) return false;
  await locator.click();
  return true;
}

async function clickFirstVisibleSelector(page: RednoteBrowserPage, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if ((await locator.count()) > 0 && (await locator.first().isVisible())) {
      await locator.first().click();
      return true;
    }
  }
  return false;
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

async function pageContainsAnyText(page: RednoteBrowserPage, texts: string[]): Promise<boolean> {
  if (!page.evaluate) return false;
  return page.evaluate((rawTexts) => {
    const expectedTexts = JSON.parse(rawTexts) as string[];
    const text = (((globalThis as any).document.body?.innerText ?? "") as string);
    return expectedTexts.some((item) => text.includes(item));
  }, JSON.stringify(texts));
}

async function switchToRednoteImageTextTab(page: RednoteBrowserPage): Promise<void> {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if ((await findFirstVisiblePlaceholder(page, ["填写标题", "请输入标题", "标题"])) !== null) return;
    if ((await findFirstVisibleText(page, ["上传图片", "文字配图", "写文字", "生成图片"])) !== null) return;
    if (!(await clickFirstVisibleSelector(page, [".creator-tab[data-hp-kind='creator-tab-上传图文']", ".header-tabs .creator-tab:nth-child(2)"]))) {
      await clickFirstVisibleText(page, ["上传图文"]);
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

async function isRednoteFinalEditor(page: BrowserPage): Promise<boolean> {
  return (await findFirstVisiblePlaceholder(page, ["填写标题会有更多赞哦", "填写标题", "请输入标题", "标题"])) !== null;
}

async function isRednotePublishPageReady(page: BrowserPage): Promise<boolean> {
  return (
    page.url().includes("creator.xiaohongshu.com/publish") &&
    ((await isRednoteFinalEditor(page)) ||
      (await findFirstVisibleText(page, ["写文字", "上传图片", "文字配图", "预览图片", "下一步"])) !== null)
  );
}

async function isRednoteLoginRequired(page: BrowserPage): Promise<boolean> {
  const currentUrl = page.url();
  if (currentUrl.includes("/login")) return true;
  if (
    (await findFirstVisibleText(page, [
      "小红书创作服务平台",
      "发布笔记",
      "创作中心",
      "笔记管理",
      "数据中心",
      "上传视频",
      "上传图文",
      "文字配图"
    ])) !== null
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
        const prototype = editable.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(editable, text);
        else editable.value = text;
        editable.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
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
  if (await forceFillRednoteFinalEditor(page, title, body)) return "NOTE_EDITOR";

  if (page.evaluate) {
    await page.evaluate(() => {
      const doc = Reflect.get(globalThis, "document");
      const scroller = doc.querySelector(".publish-page");
      if (scroller) scroller.scrollTop = 0;
      return true;
    }, "");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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
    await fillText(page, bodyLocator, buildRednoteImagePrompt(title, body));
    return "TEXT_TO_IMAGE";
  }
  if (!titleLocator) return null;
  await fillText(page, titleLocator, formatRednoteTitle(title));
  await fillText(page, bodyLocator, body);
  return "NOTE_EDITOR";
}

async function forceFillRednoteFinalEditor(page: RednoteBrowserPage, title: string, body: string): Promise<boolean> {
  if (!page.evaluate) return false;
  return page.evaluate((rawDraft) => {
    const draft = JSON.parse(rawDraft);
    const win = globalThis;
    const doc = Reflect.get(win, "document");
    const inputEvent = Reflect.get(win, "InputEvent");
    const titleInput = doc.querySelector(".publish-page input[placeholder*='标题'], input[placeholder*='标题']");
    const bodyEditor = doc.querySelector(
      ".publish-page-content [contenteditable='true'], .publish-page .ProseMirror[contenteditable='true']"
    );
    if (!titleInput || !bodyEditor) return false;

    const scroller = doc.querySelector(".publish-page");
    if (scroller) scroller.scrollTop = 0;

    titleInput.focus();
    const inputPrototype = Reflect.get(win, "HTMLInputElement").prototype;
    const titleSetter = Object.getOwnPropertyDescriptor(inputPrototype, "value")?.set;
    if (titleSetter) titleSetter.call(titleInput, draft.title);
    else titleInput.value = draft.title;
    titleInput.dispatchEvent(new inputEvent("input", { bubbles: true, inputType: "insertText", data: draft.title }));
    titleInput.dispatchEvent(new Event("change", { bubbles: true }));

    bodyEditor.focus();
    bodyEditor.textContent = "";
    doc.execCommand("selectAll", false);
    doc.execCommand("insertText", false, draft.body);
    bodyEditor.dispatchEvent(new inputEvent("input", { bubbles: true, inputType: "insertText", data: draft.body }));
    return true;
  }, JSON.stringify({ title: formatRednoteTitle(title), body }));
}

function formatRednoteTitle(title: string): string {
  return Array.from(title.trim()).slice(0, 20).join("");
}

function buildRednoteImagePrompt(title: string, body: string): string {
  const cleanBody = body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join(" ")
    .slice(0, 120);
  return [title.trim(), cleanBody].filter(Boolean).join("\n");
}

async function clickFirstGeneratedImage(page: RednoteBrowserPage): Promise<boolean> {
  return clickFirstVisibleSelector(page, [
    ".cover-list-container .cover-item.active",
    ".cover-list-container .cover-item",
    ".image-overview .swiper-slide-active",
    ".image-overview .swiper-slide"
  ]);
}

async function clickGenerateRednoteImage(page: RednoteBrowserPage): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    (await clickFirstVisibleSelector(page, [".edit-text-button", ".edit-text-button-container .edit-text-button"])) ||
      (await clickFirstText(page, ["生成图片"]));
    const started = await waitUntil(
      async () =>
        (await isRednoteFinalEditor(page)) ||
        (await pageContainsAnyText(page, ["图片生成中", "预览图片"])) ||
        (await findFirstVisibleText(page, ["下一步"])) !== null ||
        (await findFirstVisibleLocator(page, [".image-overview", ".cover-list-container"])) !== null,
      3500,
      500
    );
    if (started) return true;
  }
  return false;
}

async function clickRednotePublishButton(page: RednoteBrowserPage): Promise<boolean> {
  if (page.evaluate) {
    const clicked = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const win = globalThis as any;
      const scroller = doc.querySelector(".publish-page");
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
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
      const target = (Array.from(doc.querySelectorAll("button, [role='button'], .d-button")) as any[]).find(
        (element) => (element.innerText || element.textContent || "").trim() === "发布" && isVisible(element)
      );
      if (!target) return false;
      target.scrollIntoView?.({ block: "center", inline: "center" });
      for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        target.dispatchEvent(new win.MouseEvent(eventName, { bubbles: true, cancelable: true, view: win }));
      }
      target.click?.();
      return true;
    }, "");
    if (clicked) return true;
  }
  return clickFirstText(page, ["发布"]);
}

async function runRednoteTextToImageFlow(page: RednoteBrowserPage, title: string, body: string): Promise<void> {
  if (await isRednoteFinalEditor(page)) return;

  await switchToRednoteImageTextTab(page);
  if (await isRednoteFinalEditor(page)) return;

  if ((await findFirstVisibleText(page, ["上传图片", "文字配图"])) !== null) {
    (await clickFirstVisibleSelector(page, [".image-upload-buttons button.text2image-button", "button.text2image-button"])) ||
      (await clickFirstText(page, ["文字配图"]));
  }
  await waitForAnyVisible(page, [
    () => findFirstVisibleLocator(page, ["[contenteditable='true']", ".ProseMirror"]),
    () => findFirstVisibleText(page, ["生成图片"])
  ]);

  if (!(await isRednoteFinalEditor(page))) {
    const bodyLocator = await findFirstVisibleLocator(page, ["[contenteditable='true']", ".ProseMirror"]);
    if (bodyLocator) await fillText(page, bodyLocator, buildRednoteImagePrompt(title, body));
    await clickGenerateRednoteImage(page);
    await waitUntil(
      async () =>
        (await isRednoteFinalEditor(page)) ||
        (await findFirstVisibleText(page, ["下一步"])) !== null ||
        (await findFirstVisibleLocator(page, [".image-overview", ".cover-list-container"])) !== null,
      45000,
      1000
    );
  }

  if (!(await isRednoteFinalEditor(page))) {
    await clickFirstGeneratedImage(page);
    (await clickFirstVisibleSelector(page, [".overview-footer button", ".overview-footer .d-button"])) ||
      (await clickFirstText(page, ["下一步"]));
    await waitUntil(() => isRednoteFinalEditor(page), 20000);
  }
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
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
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
        await clickGenerateRednoteImage(page);
        await waitUntil(
          async () =>
            (await isRednoteFinalEditor(page)) ||
            (await findFirstVisibleText(page, ["下一步"])) !== null ||
            (await findFirstVisibleLocator(page, [".image-overview", ".cover-list-container"])) !== null,
          45000,
          1000
        );
        if (!(await isRednoteFinalEditor(page))) {
          await clickFirstGeneratedImage(page);
          (await clickFirstVisibleSelector(page, [".overview-footer button", ".overview-footer .d-button"])) ||
            (await clickFirstText(page, ["下一步"]));
          await waitUntil(() => isRednoteFinalEditor(page), 20000);
        }
        const finalFilledMode = await fillRednoteForm(page, draft.title, draft.body);
        if (finalFilledMode !== "NOTE_EDITOR") {
          return {
            status: "NEEDS_USER_ACTION",
            message: "小红书文字配图内容已填入，但没有进入最终发布编辑页，请在当前页面点击生成图片并下一步",
            publishedUrl: page.url()
          };
        }
      }
      const clickedPublish = await clickRednotePublishButton(page);
      if (!clickedPublish) {
        return {
          status: "NEEDS_USER_ACTION",
          message: "小红书标题和正文已填入，但没有找到发布按钮，请在当前页面确认后手动点击发布",
          publishedUrl: page.url()
        };
      }
      return {
        status: "SUCCESS",
        message: "小红书标题和正文已填入并点击发布",
        publishedUrl: page.url()
      };
    }
  };
}

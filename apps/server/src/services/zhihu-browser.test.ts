import { describe, expect, it } from "vitest";
import { createZhihuBrowserPublisher, zhihuArticleWriteUrl, zhihuLoginUrl } from "./zhihu-browser.js";

function createFakeLocator() {
  return {
    fillCalls: [] as string[],
    clickCalls: 0,
    fill(value: string) {
      this.fillCalls.push(value);
      return Promise.resolve();
    },
    click() {
      this.clickCalls += 1;
      return Promise.resolve();
    },
    count() {
      return Promise.resolve(1);
    },
    first() {
      return this;
    },
    isVisible() {
      return Promise.resolve(true);
    },
    textContent() {
      return Promise.resolve(null);
    }
  };
}

function createFakePage(options?: { loginPage?: boolean }) {
  const title = createFakeLocator();
  const body = createFakeLocator();
  const publish = createFakeLocator();
  const confirm = createFakeLocator();
  const hidden = {
    count: () => Promise.resolve(0),
    first: () => hidden,
    fill: () => Promise.resolve(),
    click: () => Promise.resolve(),
    isVisible: () => Promise.resolve(false)
  };
  const state = {
    url: options?.loginPage ? zhihuLoginUrl : "https://zhuanlan.zhihu.com/write"
  };
  const navigations: string[] = [];
  return {
    title,
    body,
    publish,
    confirm,
    state,
    navigations,
    goto(url: string) {
      navigations.push(url);
      state.url = url;
      return Promise.resolve();
    },
    waitForLoadState() {
      return Promise.resolve();
    },
    url() {
      return state.url;
    },
    locator(selector: string) {
      if (selector.includes("标题")) return title;
      if (selector.includes("内容") || selector.includes("正文") || selector.includes("contenteditable")) return body;
      if (selector.includes("确认")) return confirm;
      return hidden;
    },
    getByText(text: string) {
      if (text === "发布" || text === "发表") return publish;
      if (text === "确认发布" || text === "确定") return confirm;
      if (text === "验证码登录" || text === "密码登录" || text === "登录/注册") return hidden;
      return hidden;
    }
  };
}

describe("zhihu browser publisher", () => {
  it("opens the Zhihu login page", async () => {
    const page = createFakePage({ loginPage: true });
    const publisher = createZhihuBrowserPublisher({
      openPage: async () => page
    });

    const result = await publisher.openLoginPage();

    expect(result.url).toBe(zhihuLoginUrl);
    expect(page.navigations).toContain(zhihuLoginUrl);
  });

  it("fills the Zhihu editor and clicks publish", async () => {
    const page = createFakePage();
    const publisher = createZhihuBrowserPublisher({
      openPage: async () => page
    });

    const result = await publisher.publish({
      title: "知乎文章标题",
      body: "这是知乎文章正文。",
      tags: ["AI", "效率"],
      images: [{ name: "cover.png", url: "https://example.com/cover.png" }]
    });

    expect(page.navigations).toContain(zhihuArticleWriteUrl);
    expect(page.title.fillCalls).toContain("知乎文章标题");
    expect(page.body.fillCalls).toContain("这是知乎文章正文。");
    expect(page.publish.clickCalls).toBeGreaterThan(0);
    expect(result.status).toBe("SUCCESS");
  });
});

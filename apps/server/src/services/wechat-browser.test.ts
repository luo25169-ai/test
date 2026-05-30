import { describe, expect, it } from "vitest";
import { createWechatBrowserPublisher, wechatArticleEditUrl, wechatLoginUrl } from "./wechat-browser.js";

function createFakeLocator(visible = true) {
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
      return Promise.resolve(visible ? 1 : 0);
    },
    first() {
      return this;
    },
    isVisible() {
      return Promise.resolve(visible);
    }
  };
}

function createHiddenLocator() {
  return createFakeLocator(false);
}

function createThrowingLocator() {
  const locator = createFakeLocator();
  return {
    ...locator,
    fill() {
      return Promise.reject(new Error("not editable"));
    }
  };
}

function createFakePage(options?: { loggedIn?: boolean; accountNameRequired?: boolean; pageEditorWrapper?: boolean }) {
  const title = createFakeLocator();
  const body = createFakeLocator();
  const hidden = createHiddenLocator();
  const pageEditorWrapper = createThrowingLocator();
  const accountNameRequired = createFakeLocator();
  const state = {
    url: wechatLoginUrl,
    closed: false
  };
  const navigations: string[] = [];
  return {
    title,
    body,
    navigations,
    close() {
      state.closed = true;
    },
    goto(url: string) {
      if (state.closed) return Promise.reject(new Error("Target page, context or browser has been closed"));
      navigations.push(url);
      if (url === wechatLoginUrl && options?.loggedIn) {
        state.url = "https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token=123456";
      } else {
        state.url = url;
      }
      return Promise.resolve();
    },
    waitForLoadState() {
      return Promise.resolve();
    },
    url() {
      return state.url;
    },
    locator(selector: string) {
      if (selector.includes("activity-name") || selector.includes("title") || selector.includes("标题")) return title;
      if (options?.pageEditorWrapper && selector === "#js_editor") return pageEditorWrapper;
      return hidden;
    },
    getByPlaceholder() {
      return hidden;
    },
    getByText(text: string) {
      if (options?.accountNameRequired && (text === "当前公众号名称" || text === "修改名称")) return accountNameRequired;
      return hidden;
    },
    frameLocator(selector: string) {
      if (selector.includes("ueditor") || selector.includes("editor")) {
        return {
          locator(frameSelector: string) {
            if (frameSelector.includes("body") || frameSelector.includes("contenteditable")) return body;
            return hidden;
          }
        };
      }
      return {
        locator() {
          return hidden;
        }
      };
    },
    isClosed() {
      return state.closed;
    }
  };
}

function createLoginExpiredPage() {
  const page = createFakePage();
  const loginExpired = createFakeLocator();
  return {
    ...page,
    getByText(text: string) {
      if (text === "登录超时" || text === "请重新登录") return loginExpired;
      return createHiddenLocator();
    }
  };
}

describe("wechat browser publisher", () => {
  it("opens the WeChat public account login page", async () => {
    const page = createFakePage();
    const publisher = createWechatBrowserPublisher({
      openPage: async () => page
    });

    const result = await publisher.openLoginPage();

    expect(result.url).toBe(wechatLoginUrl);
    expect(page.navigations).toContain(wechatLoginUrl);
  });

  it("fills the WeChat editor draft and stops before publishing", async () => {
    const page = createFakePage({ loggedIn: true, pageEditorWrapper: true });
    const publisher = createWechatBrowserPublisher({
      openPage: async () => page
    });

    const result = await publisher.publish({
      title: "WeChat title",
      body: "WeChat body",
      tags: ["AI", "效率"],
      images: [{ name: "cover.png", url: "https://example.com/cover.png" }]
    });

    expect(page.navigations).toContain(`${wechatArticleEditUrl}&action=edit&type=10&lang=zh_CN&token=123456`);
    expect(page.title.fillCalls).toContain("WeChat title");
    expect(page.body.fillCalls).toContain("WeChat body");
    expect(result.status).toBe("NEEDS_USER_ACTION");
    expect(result.message).toContain("草稿已填入");
  });

  it("reopens a managed page when the remembered WeChat tab was closed", async () => {
    const closedPage = createFakePage();
    const loggedInPage = createFakePage({ loggedIn: true, pageEditorWrapper: true });
    const pages = [closedPage, loggedInPage];
    const publisher = createWechatBrowserPublisher({
      openManagedPage: async () => pages.shift() ?? loggedInPage
    });

    await publisher.openLoginPage();
    closedPage.close();

    const result = await publisher.publish({
      title: "WeChat title",
      body: "WeChat body",
      tags: ["AI"],
      images: []
    });

    expect(loggedInPage.navigations).toContain(`${wechatArticleEditUrl}&action=edit&type=10&lang=zh_CN&token=123456`);
    expect(loggedInPage.title.fillCalls).toContain("WeChat title");
    expect(loggedInPage.body.fillCalls).toContain("WeChat body");
    expect(result.status).toBe("NEEDS_USER_ACTION");
  });

  it("asks the user to log in again when the WeChat session has expired", async () => {
    const page = createLoginExpiredPage();
    const publisher = createWechatBrowserPublisher({
      openPage: async () => page
    });

    const result = await publisher.publish({
      title: "WeChat title",
      body: "WeChat body",
      tags: [],
      images: []
    });

    expect(result.status).toBe("NEEDS_LOGIN");
    expect(result.message).toContain("完成登录");
  });

  it("stops with a clear action when the WeChat account profile blocks editing", async () => {
    const page = createFakePage({ loggedIn: true, accountNameRequired: true });
    const publisher = createWechatBrowserPublisher({
      openPage: async () => page
    });

    const result = await publisher.publish({
      title: "WeChat title",
      body: "WeChat body",
      tags: [],
      images: []
    });

    expect(result.status).toBe("NEEDS_USER_ACTION");
    expect(result.message).toContain("修改公众号名称");
    expect(page.title.fillCalls).toHaveLength(0);
  });
});

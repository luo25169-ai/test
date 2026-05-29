import { describe, expect, it } from "vitest";
import { createRednoteBrowserPublisher, rednoteLoginUrl, rednotePublishUrl } from "./rednote-browser.js";

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

function hiddenLocator() {
  return createFakeLocator(false);
}

function createFakePage(options?: { loggedIn?: boolean }) {
  const title = createFakeLocator();
  const body = createFakeLocator();
  const login = createFakeLocator();
  const hidden = hiddenLocator();
  const state = {
    url: options?.loggedIn ? "https://creator.xiaohongshu.com/" : rednoteLoginUrl
  };
  const navigations: string[] = [];
  return {
    title,
    body,
    login,
    navigations,
    goto(url: string) {
      navigations.push(url);
      state.url = url === rednoteLoginUrl && options?.loggedIn ? "https://creator.xiaohongshu.com/" : url;
      return Promise.resolve();
    },
    waitForLoadState() {
      return Promise.resolve();
    },
    url() {
      return state.url;
    },
    locator(selector: string) {
      if (selector.includes("title") || selector.includes("标题")) return title;
      if (selector.includes("textarea") || selector.includes("contenteditable") || selector.includes("editor")) return body;
      if (!options?.loggedIn && selector.includes("login")) return login;
      return hidden;
    },
    getByPlaceholder(text: string) {
      if (text.includes("标题")) return title;
      if (text.includes("正文") || text.includes("描述") || text.includes("分享")) return body;
      return hidden;
    },
    getByText(text: string) {
      if (!options?.loggedIn && (text === "登录" || text === "扫码登录")) return login;
      return hidden;
    },
    isClosed() {
      return false;
    }
  };
}

describe("rednote browser publisher", () => {
  it("opens the Rednote login page", async () => {
    const page = createFakePage();
    const publisher = createRednoteBrowserPublisher({ openPage: async () => page });

    const result = await publisher.openLoginPage();

    expect(result.url).toBe(rednoteLoginUrl);
    expect(page.navigations).toContain(rednoteLoginUrl);
  });

  it("fills a Rednote note and stops before final publishing", async () => {
    const page = createFakePage({ loggedIn: true });
    const publisher = createRednoteBrowserPublisher({ openPage: async () => page });

    const result = await publisher.publish({
      title: "Rednote title",
      body: "Rednote body #AI",
      tags: ["AI"],
      images: []
    });

    expect(page.navigations).toContain(rednotePublishUrl);
    expect(page.title.fillCalls).toContain("Rednote title");
    expect(page.body.fillCalls).toContain("Rednote body #AI");
    expect(result.status).toBe("NEEDS_USER_ACTION");
  });

  it("checks login state without reopening the login page", async () => {
    const page = createFakePage({ loggedIn: true });
    const publisher = createRednoteBrowserPublisher({ openPage: async () => page });

    const result = await publisher.checkLoginStatus();

    expect(result.connected).toBe(true);
    expect(page.navigations).not.toContain(rednoteLoginUrl);
  });
});

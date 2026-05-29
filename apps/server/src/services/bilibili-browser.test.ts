import { describe, expect, it } from "vitest";
import { bilibiliDynamicUrl, bilibiliLoginUrl, createBilibiliBrowserPublisher } from "./bilibili-browser.js";

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

function createFakePage(options?: { loggedIn?: boolean }) {
  const editor = createFakeLocator();
  const login = createFakeLocator();
  const hidden = createHiddenLocator();
  const state = {
    url: options?.loggedIn ? "https://www.bilibili.com/" : bilibiliLoginUrl
  };
  const navigations: string[] = [];
  return {
    editor,
    login,
    navigations,
    goto(url: string) {
      navigations.push(url);
      if (url === bilibiliLoginUrl && options?.loggedIn) {
        state.url = "https://www.bilibili.com/";
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
      if (selector.includes("contenteditable") || selector.includes("textarea") || selector.includes("editor")) return editor;
      if (!options?.loggedIn && selector.includes("login")) return login;
      return hidden;
    },
    getByPlaceholder(text: string) {
      if (text.includes("动态") || text.includes("说点")) return editor;
      return hidden;
    },
    getByText(text: string) {
      if (!options?.loggedIn && (text === "登录" || text === "立即登录")) return login;
      return hidden;
    },
    isClosed() {
      return false;
    }
  };
}

describe("bilibili browser publisher", () => {
  it("opens the Bilibili login page", async () => {
    const page = createFakePage();
    const publisher = createBilibiliBrowserPublisher({
      openPage: async () => page
    });

    const result = await publisher.openLoginPage();

    expect(result.url).toBe(bilibiliLoginUrl);
    expect(page.navigations).toContain(bilibiliLoginUrl);
  });

  it("fills a Bilibili dynamic and stops before final publishing", async () => {
    const page = createFakePage({ loggedIn: true });
    const publisher = createBilibiliBrowserPublisher({
      openPage: async () => page
    });

    const result = await publisher.publish({
      body: "Bilibili body #AI",
      tags: ["AI"],
      images: []
    });

    expect(page.navigations).toContain(bilibiliDynamicUrl);
    expect(page.editor.fillCalls).toContain("Bilibili body #AI");
    expect(result.status).toBe("NEEDS_USER_ACTION");
    expect(result.message).toContain("动态内容已填入");
  });

  it("prefers an existing authenticated Bilibili page from the user browser", async () => {
    const managedPage = createFakePage();
    const userPage = createFakePage({ loggedIn: true });
    const publisher = createBilibiliBrowserPublisher({
      openPage: async () => managedPage,
      openUserPage: async () => userPage
    });

    const result = await publisher.publish({
      body: "Bilibili body #AI",
      tags: ["AI"],
      images: []
    });

    expect(userPage.navigations).toContain(bilibiliDynamicUrl);
    expect(userPage.editor.fillCalls).toContain("Bilibili body #AI");
    expect(managedPage.navigations).toHaveLength(0);
    expect(result.status).toBe("NEEDS_USER_ACTION");
  });

  it("asks the user to log in before publishing when Bilibili is not authenticated", async () => {
    const page = createFakePage();
    const publisher = createBilibiliBrowserPublisher({
      openPage: async () => page
    });

    const result = await publisher.publish({
      body: "Bilibili body #AI",
      tags: [],
      images: []
    });

    expect(result.status).toBe("NEEDS_LOGIN");
    expect(result.message).toContain("登录");
  });
});

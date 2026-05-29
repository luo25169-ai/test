# WeChat Draft Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a WeChat public-account browser flow that reuses an authenticated Chrome session, opens the official WeChat editor, fills title and body, and stops before clicking the final publish button so the draft can be inspected first.

**Architecture:** Keep WeChat isolated in its own browser publisher module so the existing Zhihu flow stays untouched. The new publisher will share the same persistent-browser pattern as Zhihu, but it may need iframe-aware editing because the WeChat body editor often lives inside a frame. The API layer will treat WeChat as a first-class platform: `open-login` should open the WeChat login/home page, and `publish` should create a task that fills the draft and returns a `NEEDS_USER_ACTION` result instead of clicking publish.

**Tech Stack:** TypeScript, Playwright Core, Express, Vitest, Supertest, pnpm workspaces.

---

## File Structure

- Create `apps/server/src/services/wechat-browser.ts` for the WeChat browser publisher and browser-session helpers.
- Create `apps/server/src/services/wechat-browser.test.ts` for login/open-page and draft-fill coverage.
- Modify `apps/server/src/services/publish-service.ts` to route WeChat publishes through the WeChat browser publisher.
- Modify `apps/server/src/app.ts` to allow `wechat` in the open-login endpoint and to instantiate the WeChat publisher.
- Modify `apps/server/src/services/zhihu-browser.ts` only if the shared browser interface needs iframe support that WeChat requires.

## Task 1: Capture The WeChat Editor Contract In Tests

**Files:**
- Create: `apps/server/src/services/wechat-browser.test.ts`
- Modify: `apps/server/src/services/zhihu-browser.ts` if `BrowserPage` needs `frameLocator`

- [ ] **Step 1: Write the failing tests**

Add a focused publisher test suite that proves two behaviors:

1. `openLoginPage()` navigates to the WeChat login/home entry page and returns its URL.
2. `publish()` fills the title and body on a fake WeChat editor page, including the iframe case if the body editor is inside a frame, and returns `NEEDS_USER_ACTION` with a message that the draft has been filled but not yet published.

Use a fake page shaped like this if the body editor requires a frame:

```ts
const page = {
  goto: vi.fn(async () => {}),
  waitForLoadState: vi.fn(async () => {}),
  url: () => "https://mp.weixin.qq.com/",
  locator: (selector: string) => {
    if (selector.includes("title")) return titleLocator;
    return hiddenLocator;
  },
  frameLocator: (selector: string) => {
    if (selector.includes("ueditor")) return bodyFrameLocator;
    return hiddenFrameLocator;
  }
};
```

Expected assertions:

```ts
expect(titleLocator.fillCalls).toContain("WeChat title");
expect(bodyLocator.fillCalls).toContain("WeChat body");
expect(result.status).toBe("NEEDS_USER_ACTION");
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
cd /Users/tangqianneng/Desktop/ContentFlow/apps/server
pnpm test -- --run src/services/wechat-browser.test.ts
```

Expected: fail because `wechat-browser.ts` does not exist yet, or because the editor selectors/frame behavior is not implemented yet.

## Task 2: Implement The WeChat Browser Publisher

**Files:**
- Create: `apps/server/src/services/wechat-browser.ts`
- Modify: `apps/server/src/services/zhihu-browser.ts` only if `BrowserPage` needs `frameLocator`

- [ ] **Step 1: Implement the publisher**

Create `createWechatBrowserPublisher()` using the same persistent-browser pattern that already works for Zhihu:

```ts
export function createWechatBrowserPublisher(options: WechatBrowserPublisherOptions = {}): WechatBrowserPublisher {
  return {
    async openLoginPage() { /* open mp.weixin.qq.com and activate Chrome */ },
    async publish(draft) { /* open the article editor, fill title/body, stop before publish */ }
  };
}
```

Implementation details:

1. Reuse a long-lived Chrome session so login can be completed once and reused.
2. Open the WeChat login/home entry page in `openLoginPage()`.
3. In `publish()`, navigate to the editor page after login.
4. Fill the title first.
5. Fill the body either through a normal locator or through `frameLocator(...)` if the editor lives inside an iframe.
6. Do not click the final publish button yet.
7. Return:

```ts
{
  status: "NEEDS_USER_ACTION",
  message: "公众号草稿已填入，请确认内容后手动发布"
}
```

- [ ] **Step 2: Run the WeChat tests and verify GREEN**

Run:

```bash
cd /Users/tangqianneng/Desktop/ContentFlow/apps/server
pnpm test -- --run src/services/wechat-browser.test.ts
```

Expected: PASS, including the title/body fill assertions.

## Task 3: Wire WeChat Into The Server

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/services/publish-service.ts`

- [ ] **Step 1: Add the WeChat publisher to the server composition**

Instantiate both browser publishers in `apps/server/src/app.ts` and pass the WeChat publisher into the publish service.

The open-login route should accept `wechat`:

```ts
if (platformId === "zhihu") {
  const result = await zhihuBrowserPublisher.openLoginPage();
  res.json({ platformId, ...result, message: "已打开知乎登录页，请完成登录后返回 ContentFlow 发布。" });
  return;
}

if (platformId === "wechat") {
  const result = await wechatBrowserPublisher.openLoginPage();
  res.json({ platformId, ...result, message: "已打开公众号登录页，请完成登录后返回 ContentFlow 发布。" });
  return;
}
```

In `createPublishTask()`, route `platformId === "wechat"` through the new WeChat publisher the same way Zhihu is already routed through its browser publisher, but keep the return status as `NEEDS_USER_ACTION` until the final publish button is intentionally added later.

- [ ] **Step 2: Update or add service tests for the new routing**

Extend the existing publish-service test coverage so one case publishes `["wechat"]` and asserts the task contains a WeChat result with the draft-fill message instead of throwing.

Suggested assertion shape:

```ts
expect(task.results[0].platformId).toBe("wechat");
expect(task.results[0].status).toBe("NEEDS_USER_ACTION");
expect(task.results[0].message).toContain("草稿已填入");
```

- [ ] **Step 3: Run backend tests and verify GREEN**

Run:

```bash
cd /Users/tangqianneng/Desktop/ContentFlow/apps/server
pnpm test
pnpm build
```

Expected: both commands pass.

## Task 4: End-to-End Verification

**Files:**
- None beyond the server files above

- [ ] **Step 1: Verify the WeChat login endpoint**

Run:

```bash
curl -i -sS -X POST http://localhost:4000/api/accounts/wechat/open-login
```

Expected: `200 OK` with a JSON body that says the WeChat login page has been opened.

- [ ] **Step 2: Verify the WeChat publish task**

Run:

```bash
curl -i -sS -X POST http://localhost:4000/api/publish \
  -H 'Content-Type: application/json' \
  -d '{"draft":{"title":"AI 工具提升内容创作效率","content":"今天测试一款 AI 内容工具。它可以根据不同平台生成对应版本，并帮助创作者减少重复排版工作。","tags":["AI","效率","内容创作"],"images":[{"name":"cover.png","url":"https://example.com/cover.png","type":"image/png"}]},"platformIds":["wechat"]}'
```

Expected: `201 Created`, with a task payload whose WeChat result is `NEEDS_USER_ACTION` and whose log entries show the draft was filled.

- [ ] **Step 3: Commit the feature**

Run:

```bash
git add apps/server/src/services/wechat-browser.ts apps/server/src/services/wechat-browser.test.ts apps/server/src/services/publish-service.ts apps/server/src/app.ts apps/server/src/services/zhihu-browser.ts
git commit -m "feat: add wechat draft fill browser flow"
```

Expected: a clean commit on `main`.

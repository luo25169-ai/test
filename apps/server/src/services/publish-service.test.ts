import { describe, expect, it } from "vitest";
import { createPublishTask } from "./publish-service.js";

type TestPublishTask = Awaited<ReturnType<typeof createPublishTask>>;

async function waitForTaskSettled(task: TestPublishTask): Promise<TestPublishTask> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (task.status !== "RUNNING") return task;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Publish task did not settle in time");
}

async function waitForPublishStart(getRelease: () => (() => void) | undefined): Promise<() => void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const release = getRelease();
    if (release) return release;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Publish did not start in time");
}

describe("publish service", () => {
  it("creates a real task result for each selected platform", async () => {
    const task = await createPublishTask({
      draft: {
        title: "AI 工具提升内容创作效率",
        content:
          "今天测试一款 AI 内容工具。它可以根据不同平台生成对应版本，并帮助创作者减少重复排版工作。",
        tags: ["AI", "效率"],
        images: [{ name: "cover.png", url: "https://example.com/cover.png", type: "image/png" }]
      },
      platformIds: ["wechat", "zhihu"]
    });

    const settledTask = await waitForTaskSettled(task);
    expect(settledTask.status).toBe("SUCCESS");
    expect(task.results).toHaveLength(2);
    expect(task.logs.some((log) => log.message.includes("BrowserExecutor"))).toBe(true);
    expect(task.results.every((result) => result.status === "SUCCESS")).toBe(true);
  });

  it("marks invalid platform content as failed and preserves logs", async () => {
    const task = await createPublishTask({
      draft: {
        title: "这个小红书标题已经明显超过二十个字限制很多",
        content: "这条内容标题过长。",
        tags: ["AI"],
        images: []
      },
      platformIds: ["rednote"]
    });

    expect(task.status).toBe("FAILED");
    expect(task.results[0]?.status).toBe("FAILED");
    expect(task.logs.some((log) => log.message.includes("标题不能超过"))).toBe(true);
  });

  it("publishes the provided adapted content instead of re-adapting the original draft", async () => {
    let publishedDraft: { title: string; body: string; tags: string[] } | undefined;

    const task = await createPublishTask(
      {
        draft: {
          title: "原始标题",
          content: "原始正文",
          tags: ["原始标签"],
          images: []
        },
        platformIds: ["zhihu"],
        adapted: [
          {
            platformId: "zhihu",
            platform: "知乎",
            content: {
              title: "适配后的知乎标题",
              summary: "适配后的摘要",
              body: "适配后的知乎正文",
              tags: ["适配标签"],
              images: []
            },
            validation: { valid: true, issues: [] }
          }
        ]
      },
      {
        zhihuPublisher: {
          async openLoginPage() {
            return { url: "https://www.zhihu.com/signin" };
          },
          async publish(draft) {
            publishedDraft = draft;
            return {
              status: "NEEDS_USER_ACTION",
              message: "知乎内容已填入，请确认内容后手动发布"
            };
          }
        }
      }
    );

    await waitForTaskSettled(task);
    expect(task.adapted[0]?.content.title).toBe("适配后的知乎标题");
    expect(publishedDraft?.title).toBe("适配后的知乎标题");
    expect(publishedDraft?.body).toBe("适配后的知乎正文");
    expect(publishedDraft?.tags).toEqual(["适配标签"]);
  });

  it("returns a running task before browser publishing settles", async () => {
    let releasePublish: (() => void) | undefined;

    const task = await createPublishTask(
      {
        draft: {
          title: "AI 工具提升内容创作效率",
          content: "今天测试一款 AI 内容工具。",
          tags: ["AI", "效率"],
          images: []
        },
        platformIds: ["bilibili"]
      },
      {
        bilibiliPublisher: {
          async openLoginPage() {
            return { url: "https://passport.bilibili.com/login" };
          },
          async checkLoginStatus() {
            return { connected: true };
          },
          async publish() {
            await new Promise<void>((resolve) => {
              releasePublish = resolve;
            });
            return {
              status: "NEEDS_USER_ACTION",
              message: "B站动态内容已填入，请确认内容后手动发布"
            };
          }
        }
      }
    );

    expect(task.status).toBe("RUNNING");
    expect(task.results[0]?.status).toBe("PENDING");

    const release = await waitForPublishStart(() => releasePublish);
    release();
    await waitForTaskSettled(task);
    expect(task.status).toBe("PARTIAL");
    expect(task.results[0]?.status).toBe("NEEDS_USER_ACTION");
  });

  it("uses mock publish mode without calling browser publishers", async () => {
    const task = await createPublishTask(
      {
        draft: {
          title: "AI 工具提升内容创作效率",
          content: "今天测试一款 AI 内容工具。",
          tags: ["AI", "效率"],
          images: []
        },
        platformIds: ["bilibili"]
      },
      {
        publishMode: "mock",
        bilibiliPublisher: {
          async openLoginPage() {
            return { url: "https://passport.bilibili.com/login" };
          },
          async checkLoginStatus() {
            return { connected: false };
          },
          async publish() {
            throw new Error("browser publisher should not run in mock mode");
          }
        }
      }
    );

    await waitForTaskSettled(task);
    expect(task.status).toBe("SUCCESS");
    expect(task.results[0]?.status).toBe("SUCCESS");
    expect(task.results[0]?.message).toContain("演示模式");
  });

  it("routes WeChat publishing through the browser draft filler", async () => {
    const task = await createPublishTask(
      {
        draft: {
          title: "AI 工具提升内容创作效率",
          content:
            "今天测试一款 AI 内容工具。它可以根据不同平台生成对应版本，并帮助创作者减少重复排版工作。",
          tags: ["AI", "效率"],
          images: [{ name: "cover.png", url: "https://example.com/cover.png", type: "image/png" }]
        },
        platformIds: ["wechat"]
      },
      {
        wechatPublisher: {
          async openLoginPage() {
            return { url: "https://mp.weixin.qq.com/" };
          },
          async publish() {
            return {
              status: "NEEDS_USER_ACTION",
              message: "公众号草稿已填入，请确认内容后手动发布"
            };
          }
        }
      }
    );

    await waitForTaskSettled(task);
    expect(task.results[0]?.platformId).toBe("wechat");
    expect(task.status).toBe("PARTIAL");
    expect(task.results[0]?.status).toBe("NEEDS_USER_ACTION");
    expect(task.results[0]?.message).toContain("草稿已填入");
  });

  it("routes Bilibili publishing through the browser dynamic filler", async () => {
    const task = await createPublishTask(
      {
        draft: {
          title: "AI 工具提升内容创作效率",
          content: "今天测试一款 AI 内容工具。",
          tags: ["AI", "效率"],
          images: []
        },
        platformIds: ["bilibili"]
      },
      {
        bilibiliPublisher: {
          async openLoginPage() {
            return { url: "https://passport.bilibili.com/login" };
          },
          async checkLoginStatus() {
            return { connected: true };
          },
          async publish() {
            return {
              status: "NEEDS_USER_ACTION",
              message: "B站动态内容已填入，请确认内容后手动发布"
            };
          }
        }
      }
    );

    await waitForTaskSettled(task);
    expect(task.results[0]?.platformId).toBe("bilibili");
    expect(task.status).toBe("PARTIAL");
    expect(task.results[0]?.status).toBe("NEEDS_USER_ACTION");
    expect(task.results[0]?.message).toContain("动态内容已填入");
  });

  it("routes Rednote publishing through the browser note filler", async () => {
    const task = await createPublishTask(
      {
        draft: {
          title: "AI 工具提升内容创作效率",
          content: "今天测试一款 AI 内容工具。",
          tags: ["AI", "效率"],
          images: [{ name: "cover.png", url: "https://example.com/cover.png", type: "image/png" }]
        },
        platformIds: ["rednote"]
      },
      {
        rednotePublisher: {
          async openLoginPage() {
            return { url: "https://creator.xiaohongshu.com/login" };
          },
          async checkLoginStatus() {
            return { connected: true };
          },
          async publish() {
            return {
              status: "NEEDS_USER_ACTION",
              message: "小红书笔记内容已填入，请上传图片并确认后手动发布"
            };
          }
        }
      }
    );

    await waitForTaskSettled(task);
    expect(task.results[0]?.platformId).toBe("rednote");
    expect(task.status).toBe("PARTIAL");
    expect(task.results[0]?.status).toBe("NEEDS_USER_ACTION");
    expect(task.results[0]?.message).toContain("笔记内容已填入");
  });
});

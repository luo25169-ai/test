import { describe, expect, it } from "vitest";
import { createPublishTask } from "./publish-service.js";

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

    expect(task.status).toBe("SUCCESS");
    expect(task.results).toHaveLength(2);
    expect(task.logs.some((log) => log.message.includes("BrowserExecutor"))).toBe(true);
    expect(task.results.every((result) => result.status === "SUCCESS")).toBe(true);
  });

  it("marks invalid platform content as failed and preserves logs", async () => {
    const task = await createPublishTask({
      draft: {
        title: "没有图片的小红书内容",
        content: "这条内容缺少图片。",
        tags: ["AI"],
        images: []
      },
      platformIds: ["rednote"]
    });

    expect(task.status).toBe("FAILED");
    expect(task.results[0]?.status).toBe("FAILED");
    expect(task.logs.some((log) => log.message.includes("小红书图文至少需要 1 张图片"))).toBe(true);
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

    expect(task.results[0]?.platformId).toBe("rednote");
    expect(task.status).toBe("PARTIAL");
    expect(task.results[0]?.status).toBe("NEEDS_USER_ACTION");
    expect(task.results[0]?.message).toContain("笔记内容已填入");
  });
});

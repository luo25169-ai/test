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
});

import { describe, expect, it } from "vitest";
import { adaptForPlatforms, platformRegistry } from "./platform-registry.js";

describe("platform adapters", () => {
  it("formats one draft into distinct platform-specific versions", () => {
    const draft = {
      title: "AI 工具提升内容创作效率",
      content:
        "今天测试一款 AI 内容工具。它可以根据不同平台生成对应版本，并帮助创作者减少重复排版工作。",
      tags: ["AI", "效率"],
      images: [{ name: "cover.png", url: "https://example.com/cover.png", type: "image/png" }]
    };

    const results = adaptForPlatforms(draft, ["wechat", "zhihu", "bilibili", "rednote"]);

    expect(results).toHaveLength(4);
    expect(results.map((item) => item.platformId)).toEqual(["wechat", "zhihu", "bilibili", "rednote"]);
    expect(results.find((item) => item.platformId === "wechat")?.content.summary).toContain("AI 工具");
    expect(results.find((item) => item.platformId === "rednote")?.content.body).toContain("#AI");
    expect(results.every((item) => item.validation.valid)).toBe(true);
    expect(platformRegistry.rednote.name).toBe("小红书");
  });

  it("reports validation errors when platform limits are violated", () => {
    const draft = {
      title: "x".repeat(80),
      content: "短内容",
      tags: ["AI"],
      images: []
    };

    const [rednote] = adaptForPlatforms(draft, ["rednote"]);

    expect(rednote.validation.valid).toBe(false);
    expect(rednote.validation.issues.some((issue) => issue.includes("标题不能超过"))).toBe(true);
  });

  it("allows Rednote text-only drafts because the browser flow can use text-to-image", () => {
    const draft = {
      title: "AI 内容效率",
      content: "今天测试一款 AI 内容工具。",
      tags: ["AI"],
      images: []
    };

    const [rednote] = adaptForPlatforms(draft, ["rednote"]);

    expect(rednote.validation.valid).toBe(true);
  });
});

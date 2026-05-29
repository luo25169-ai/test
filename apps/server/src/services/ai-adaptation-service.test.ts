import { describe, expect, it } from "vitest";
import { createArkAdapter } from "./ai-adaptation-service.js";

describe("ai adaptation service", () => {
  it("calls Ark chat completions and parses platform-specific JSON", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createArkAdapter({
      apiKey: "test-key",
      model: "doubao-seed-1-6-250615",
      fetcher: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "小红书风格标题",
                    body: "短句表达。\n突出体验感。\n#AI #效率工具",
                    summary: "短句表达，突出体验感",
                    tags: ["AI", "效率工具"]
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    const result = await adapter.adapt({
      platformId: "rednote",
      platformName: "小红书",
      platformStyle: "种草短句，强调体验、标签和图片",
      titleLimit: 20,
      bodyLimit: 1000,
      source: {
        title: "AI 工具提升内容创作效率",
        content: "今天测试一款 AI 内容工具，它可以帮助创作者减少重复排版工作。",
        tags: ["AI", "效率"],
        images: [{ name: "cover.png", url: "https://example.com/cover.png" }]
      }
    });

    expect(result.title).toBe("小红书风格标题");
    expect(result.body).toContain("#AI");
    expect(result.tags).toEqual(["AI", "效率工具"]);
    expect(requests[0]?.url).toContain("/api/v3/chat/completions");
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json"
    });
    expect(JSON.parse(String(requests[0]?.init.body)).model).toBe("doubao-seed-1-6-250615");
  });
});

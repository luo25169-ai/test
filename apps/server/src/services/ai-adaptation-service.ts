import type { AdaptedContent, DraftContent } from "../platforms/types.js";

export interface AiAdaptRequest {
  platformId: string;
  platformName: string;
  platformStyle: string;
  titleLimit: number;
  bodyLimit: number;
  source: DraftContent;
}

export interface ArkAdapterOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
}

interface ArkChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

const defaultBaseUrl = "https://ark.cn-beijing.volces.com/api/v3";

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1] ?? text;
  return JSON.parse(raw.trim());
}

function normalizeTags(tags: unknown, fallback: string[]): string[] {
  if (!Array.isArray(tags)) return fallback;
  return tags.map((tag) => String(tag).trim()).filter(Boolean);
}

function normalizeContent(value: unknown, source: DraftContent): AdaptedContent {
  const data = value as Partial<AdaptedContent>;
  const title = String(data.title ?? source.title).trim();
  const body = String(data.body ?? source.content).trim();
  const summary = String(data.summary ?? body.slice(0, 60)).trim();
  return {
    title,
    body,
    summary,
    tags: normalizeTags(data.tags, source.tags),
    images: source.images
  };
}

export function createArkAdapter(options: ArkAdapterOptions) {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = options.baseUrl ?? defaultBaseUrl;

  return {
    async adapt(request: AiAdaptRequest): Promise<AdaptedContent> {
      const response = await fetcher(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: options.model,
          messages: [
            {
              role: "system",
              content:
                "你是多平台图文内容运营助手。请只返回 JSON，不要 Markdown，不要解释。JSON 字段必须是 title、summary、body、tags。"
            },
            {
              role: "user",
              content: [
                `目标平台：${request.platformName}`,
                `平台风格：${request.platformStyle}`,
                `标题限制：不超过 ${request.titleLimit} 个中文字符`,
                `正文限制：不超过 ${request.bodyLimit} 个中文字符`,
                "改写要求：保留原意，调整语气、结构、段落和标签，使其符合平台读者偏好。",
                `原始标题：${request.source.title}`,
                `原始正文：${request.source.content}`,
                `原始标签：${request.source.tags.join("，")}`,
                `图片数量：${request.source.images.length}`
              ].join("\n")
            }
          ],
          temperature: 0.6
        })
      });

      if (!response.ok) {
        const details = await response.text();
        throw new Error(`Ark API request failed: ${response.status} ${details}`);
      }

      const json = (await response.json()) as ArkChatResponse;
      const content = json.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("Ark API returned empty content");
      }

      return normalizeContent(extractJson(content), request.source);
    }
  };
}

export function createConfiguredAiAdapter() {
  const apiKey = process.env.ARK_API_KEY;
  if (!apiKey) return null;

  return createArkAdapter({
    apiKey,
    model: process.env.ARK_MODEL ?? "doubao-seed-2-0-lite-260428",
    baseUrl: process.env.ARK_BASE_URL
  });
}

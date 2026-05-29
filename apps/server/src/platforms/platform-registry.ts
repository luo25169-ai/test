import { bilibiliAdapter, rednoteAdapter, wechatAdapter, zhihuAdapter } from "./adapters.js";
import type { AdaptationResult, DraftContent, PlatformAdapter } from "./types.js";
import type { AiAdaptRequest } from "../services/ai-adaptation-service.js";

export const platformRegistry: Record<string, PlatformAdapter> = {
  wechat: wechatAdapter,
  zhihu: zhihuAdapter,
  bilibili: bilibiliAdapter,
  rednote: rednoteAdapter
};

export function getPlatforms(): PlatformAdapter[] {
  return Object.values(platformRegistry);
}

export function adaptForPlatforms(draft: DraftContent, platformIds: string[]): AdaptationResult[] {
  return platformIds.map((platformId) => {
    const adapter = platformRegistry[platformId];
    if (!adapter) {
      throw new Error(`Unsupported platform: ${platformId}`);
    }
    const content = adapter.formatContent(draft);
    return {
      platformId,
      platform: adapter.name,
      content,
      validation: adapter.validate(content)
    };
  });
}

const platformStyles: Record<string, string> = {
  wechat: "公众号长文排版，标题清晰，摘要明确，段落完整，语气正式可信",
  zhihu: "知乎专业观点，强调逻辑、小标题、原因分析和理性表达",
  bilibili: "B站动态或专栏，语气轻松，适合社区互动，保留话题标签",
  rednote: "小红书图文笔记，短句、体验感、种草语气，标签自然"
};

export interface AiAdapter {
  adapt(request: AiAdaptRequest): Promise<{
    title: string;
    body: string;
    summary: string;
    tags: string[];
    images: DraftContent["images"];
  }>;
}

export async function adaptForPlatformsWithAi(
  draft: DraftContent,
  platformIds: string[],
  aiAdapter: AiAdapter | null
): Promise<AdaptationResult[]> {
  if (!aiAdapter) return adaptForPlatforms(draft, platformIds);

  const items: AdaptationResult[] = [];
  for (const platformId of platformIds) {
    const adapter = platformRegistry[platformId];
    if (!adapter) {
      throw new Error(`Unsupported platform: ${platformId}`);
    }

    const content = await aiAdapter.adapt({
      platformId,
      platformName: adapter.name,
      platformStyle: platformStyles[platformId] ?? adapter.name,
      titleLimit: adapter.limits.titleMax,
      bodyLimit: adapter.limits.bodyMax,
      source: draft
    });

    items.push({
      platformId,
      platform: adapter.name,
      content,
      validation: adapter.validate(content)
    });
  }

  return items;
}

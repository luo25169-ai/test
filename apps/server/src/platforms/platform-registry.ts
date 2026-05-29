import { bilibiliAdapter, rednoteAdapter, wechatAdapter, zhihuAdapter } from "./adapters.js";
import type { AdaptationResult, DraftContent, PlatformAdapter } from "./types.js";

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

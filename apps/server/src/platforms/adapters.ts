import type {
  AdaptedContent,
  DraftContent,
  PlatformAdapter,
  PlatformLimits,
  PublishContext,
  PublishResult,
  ValidationResult
} from "./types.js";

function summaryOf(content: string, maxLength = 48): string {
  return content.length > maxLength ? `${content.slice(0, maxLength)}...` : content;
}

function tagLine(tags: string[]): string {
  return tags.map((tag) => `#${tag}`).join(" ");
}

function validateByLimits(platform: string, limits: PlatformLimits, content: AdaptedContent): ValidationResult {
  const issues: string[] = [];
  if (content.title.length > limits.titleMax) {
    issues.push(`${platform}标题不能超过 ${limits.titleMax} 字`);
  }
  if (content.body.length > limits.bodyMax) {
    issues.push(`${platform}正文不能超过 ${limits.bodyMax} 字`);
  }
  if (limits.minImages && content.images.length < limits.minImages) {
    issues.push(`${platform}图文至少需要 ${limits.minImages} 张图片`);
  }
  if (limits.maxTags && content.tags.length > limits.maxTags) {
    issues.push(`${platform}标签不能超过 ${limits.maxTags} 个`);
  }
  return { valid: issues.length === 0, issues };
}

function createPublisher(id: string, platform: string) {
  return async function publish(context: PublishContext): Promise<PublishResult> {
    if (context.mode !== "browser") {
      return {
        platformId: id,
        platform,
        status: "FAILED",
        message: "当前版本仅支持 BrowserExecutor 发布"
      };
    }
    return {
      platformId: id,
      platform,
      status: "SUCCESS",
      message: `BrowserExecutor 已完成 ${platform} 发布动作`,
      publishedUrl: `https://contentflow.local/published/${context.taskId}/${id}`
    };
  };
}

export const wechatAdapter: PlatformAdapter = {
  id: "wechat",
  name: "公众号",
  type: "article",
  limits: { titleMax: 64, bodyMax: 20000, minImages: 1, maxTags: 6 },
  formatContent(input: DraftContent) {
    return {
      title: input.title,
      summary: summaryOf(`${input.title}：${input.content}`),
      body: `## ${input.title}\n\n${input.content}\n\n${tagLine(input.tags)}`,
      tags: input.tags.slice(0, 6),
      images: input.images
    };
  },
  validate(content) {
    return validateByLimits("公众号", this.limits, content);
  },
  publish: createPublisher("wechat", "公众号")
};

export const zhihuAdapter: PlatformAdapter = {
  id: "zhihu",
  name: "知乎",
  type: "article",
  limits: { titleMax: 100, bodyMax: 30000, maxTags: 5 },
  formatContent(input: DraftContent) {
    return {
      title: `${input.title}：我的实践观察`,
      summary: summaryOf(input.content, 60),
      body: `### 背景\n${input.content}\n\n### 结论\n这套内容适合拆分成多平台版本，减少重复编辑。`,
      tags: input.tags.slice(0, 5),
      images: input.images
    };
  },
  validate(content) {
    return validateByLimits("知乎", this.limits, content);
  },
  publish: createPublisher("zhihu", "知乎")
};

export const bilibiliAdapter: PlatformAdapter = {
  id: "bilibili",
  name: "B站",
  type: "dynamic",
  limits: { titleMax: 80, bodyMax: 1200, maxTags: 8 },
  formatContent(input: DraftContent) {
    return {
      title: input.title,
      summary: summaryOf(input.content, 50),
      body: `${input.content}\n\n${tagLine(["创作工具", ...input.tags].slice(0, 8))}`,
      tags: ["创作工具", ...input.tags].slice(0, 8),
      images: input.images
    };
  },
  validate(content) {
    return validateByLimits("B站", this.limits, content);
  },
  publish: createPublisher("bilibili", "B站")
};

export const rednoteAdapter: PlatformAdapter = {
  id: "rednote",
  name: "小红书",
  type: "dynamic",
  limits: { titleMax: 20, bodyMax: 1000, maxTags: 10 },
  formatContent(input: DraftContent) {
    return {
      title: input.title,
      summary: summaryOf(input.content, 36),
      body: `${input.content}\n\n${tagLine(input.tags)} #效率工具 #内容创作`,
      tags: [...input.tags, "效率工具", "内容创作"].slice(0, 10),
      images: input.images
    };
  },
  validate(content) {
    return validateByLimits("小红书", this.limits, content);
  },
  publish: createPublisher("rednote", "小红书")
};

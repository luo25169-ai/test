import { randomUUID } from "node:crypto";
import { adaptForPlatforms, platformRegistry } from "../platforms/platform-registry.js";
import type { AdaptationResult, DraftContent, PublishResult } from "../platforms/types.js";
import type { BilibiliBrowserPublisher } from "./bilibili-browser.js";
import type { RednoteBrowserPublisher } from "./rednote-browser.js";
import type { WechatBrowserPublisher } from "./wechat-browser.js";
import type { ZhihuBrowserPublisher } from "./zhihu-browser.js";

export interface PublishLog {
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
}

export interface PublishTask {
  id: string;
  status: "RUNNING" | "SUCCESS" | "FAILED" | "PARTIAL";
  draft: DraftContent;
  adapted: AdaptationResult[];
  results: PublishResult[];
  logs: PublishLog[];
  createdAt: string;
}

export interface CreatePublishTaskInput {
  draft: DraftContent;
  platformIds: string[];
  adapted?: AdaptationResult[];
}

export interface CreatePublishTaskOptions {
  bilibiliPublisher?: BilibiliBrowserPublisher;
  rednotePublisher?: RednoteBrowserPublisher;
  wechatPublisher?: WechatBrowserPublisher;
  zhihuPublisher?: ZhihuBrowserPublisher;
  publishMode?: "browser" | "mock";
}

const tasks: PublishTask[] = [];

function log(logs: PublishLog[], level: PublishLog["level"], message: string): void {
  logs.push({ level, message, createdAt: new Date().toISOString() });
}

export async function createPublishTask(
  input: CreatePublishTaskInput,
  options: CreatePublishTaskOptions = {}
): Promise<PublishTask> {
  const id = randomUUID();
  const logs: PublishLog[] = [];
  log(logs, "info", `创建发布任务 ${id}`);

  const adapted = resolveAdaptedContent(input);
  const results: PublishResult[] = adapted.map((item) =>
    item.validation.valid
      ? {
          platformId: item.platformId,
          platform: item.platform,
          status: "PENDING",
          message: "等待发布执行"
        }
      : {
          platformId: item.platformId,
          platform: item.platform,
          status: "FAILED",
          message: item.validation.issues.join("；")
        }
  );
  const hasRunnableItems = adapted.some((item) => item.validation.valid);
  const task: PublishTask = {
    id,
    status: hasRunnableItems ? "RUNNING" : "FAILED",
    draft: input.draft,
    adapted,
    results,
    logs,
    createdAt: new Date().toISOString()
  };
  tasks.unshift(task);
  if (hasRunnableItems) {
    log(logs, "info", options.publishMode === "mock" ? "任务已创建，演示模式将模拟发布成功" : "任务已创建，后台开始执行真实发布流程");
    setTimeout(() => {
      void runPublishTask(task, options);
    }, 0);
  } else {
    for (const item of adapted) {
      for (const issue of item.validation.issues) log(logs, "error", issue);
    }
  }
  return task;
}

function resolveAdaptedContent(input: CreatePublishTaskInput): AdaptationResult[] {
  const fallbackItems = adaptForPlatforms(input.draft, input.platformIds);
  const fallbackByPlatform = new Map(fallbackItems.map((item) => [item.platformId, item]));
  const providedByPlatform = new Map(
    (input.adapted ?? [])
      .filter((item) => input.platformIds.includes(item.platformId))
      .map((item) => {
        const adapter = platformRegistry[item.platformId];
        return [
          item.platformId,
          {
            platformId: item.platformId,
            platform: adapter.name,
            content: item.content,
            validation: adapter.validate(item.content)
          }
        ] as const;
      })
  );

  return input.platformIds.map((platformId) => providedByPlatform.get(platformId) ?? fallbackByPlatform.get(platformId)!);
}

async function runPublishTask(task: PublishTask, options: CreatePublishTaskOptions): Promise<void> {
  for (const item of task.adapted) {
    const resultIndex = task.results.findIndex((result) => result.platformId === item.platformId);
    if (resultIndex < 0 || !item.validation.valid) continue;

    const adapter = platformRegistry[item.platformId];
    log(task.logs, "info", `${item.platform} 内容适配完成`);
    log(task.logs, "info", `${item.platform} 校验通过，开始发布`);

    try {
      const result = options.publishMode === "mock" ? createMockPublishResult(task.id, item) : await publishWithBrowserExecutor(task.id, item, options);
      task.results[resultIndex] = result;
      log(task.logs, result.status === "FAILED" || result.status === "NEEDS_LOGIN" ? "error" : "info", result.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "发布执行失败";
      task.results[resultIndex] = {
        platformId: item.platformId,
        platform: item.platform,
        status: "FAILED",
        message
      };
      log(task.logs, "error", `${item.platform} 发布失败：${message}`);
    }
  }

  const successCount = task.results.filter((result) => result.status === "SUCCESS").length;
  const failedCount = task.results.filter((result) => result.status === "FAILED").length;
  task.status = successCount === task.results.length ? "SUCCESS" : failedCount === task.results.length ? "FAILED" : "PARTIAL";
  log(task.logs, "info", `任务 ${task.id} 执行完成：${task.status}`);
}

async function publishWithBrowserExecutor(
  taskId: string,
  item: AdaptationResult,
  options: CreatePublishTaskOptions
): Promise<PublishResult> {
  const adapter = platformRegistry[item.platformId];
  return item.platformId === "wechat" && options.wechatPublisher
    ? {
        platformId: item.platformId,
        platform: item.platform,
        ...(await options.wechatPublisher.publish({
          title: item.content.title,
          body: item.content.body,
          tags: item.content.tags,
          images: item.content.images
        }))
      }
    : item.platformId === "bilibili" && options.bilibiliPublisher
    ? {
        platformId: item.platformId,
        platform: item.platform,
        ...(await options.bilibiliPublisher.publish({
          body: item.content.body,
          tags: item.content.tags,
          images: item.content.images
        }))
      }
    : item.platformId === "zhihu" && options.zhihuPublisher
    ? {
        platformId: item.platformId,
        platform: item.platform,
        ...(await options.zhihuPublisher.publish({
          title: item.content.title,
          body: item.content.body,
          tags: item.content.tags,
          images: item.content.images
        }))
      }
    : item.platformId === "rednote" && options.rednotePublisher
    ? {
        platformId: item.platformId,
        platform: item.platform,
        ...(await options.rednotePublisher.publish({
          title: item.content.title,
          body: item.content.body,
          tags: item.content.tags,
          images: item.content.images
        }))
      }
    : await adapter.publish({
        taskId,
        adaptedContent: item.content,
        mode: "browser"
      });
}

function createMockPublishResult(taskId: string, item: AdaptationResult): PublishResult {
  return {
    platformId: item.platformId,
    platform: item.platform,
    status: "SUCCESS",
    message: `演示模式已模拟发布到${item.platform}，内容来自当前平台适配版本`,
    publishedUrl: `https://contentflow.local/demo/${taskId}/${item.platformId}`
  };
}

export function listPublishTasks(): PublishTask[] {
  return tasks;
}

export function getPublishTask(id: string): PublishTask | undefined {
  return tasks.find((task) => task.id === id);
}

import { randomUUID } from "node:crypto";
import { adaptForPlatforms, platformRegistry } from "../platforms/platform-registry.js";
import type { AdaptationResult, DraftContent, PublishResult } from "../platforms/types.js";

export interface PublishLog {
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
}

export interface PublishTask {
  id: string;
  status: "SUCCESS" | "FAILED" | "PARTIAL";
  draft: DraftContent;
  adapted: AdaptationResult[];
  results: PublishResult[];
  logs: PublishLog[];
  createdAt: string;
}

export interface CreatePublishTaskInput {
  draft: DraftContent;
  platformIds: string[];
}

const tasks: PublishTask[] = [];

function log(logs: PublishLog[], level: PublishLog["level"], message: string): void {
  logs.push({ level, message, createdAt: new Date().toISOString() });
}

export async function createPublishTask(input: CreatePublishTaskInput): Promise<PublishTask> {
  const id = randomUUID();
  const logs: PublishLog[] = [];
  log(logs, "info", `创建发布任务 ${id}`);
  log(logs, "info", "BrowserExecutor 准备使用浏览器登录态执行真实发布流程");

  const adapted = adaptForPlatforms(input.draft, input.platformIds);
  const results: PublishResult[] = [];

  for (const item of adapted) {
    const adapter = platformRegistry[item.platformId];
    log(logs, "info", `${item.platform} 内容适配完成`);
    if (!item.validation.valid) {
      for (const issue of item.validation.issues) {
        log(logs, "error", issue);
      }
      results.push({
        platformId: item.platformId,
        platform: item.platform,
        status: "FAILED",
        message: item.validation.issues.join("；")
      });
      continue;
    }

    log(logs, "info", `${item.platform} 校验通过，开始发布`);
    const result = await adapter.publish({
      taskId: id,
      adaptedContent: item.content,
      mode: "browser"
    });
    log(logs, result.status === "SUCCESS" ? "info" : "error", result.message);
    results.push(result);
  }

  const successCount = results.filter((result) => result.status === "SUCCESS").length;
  const status = successCount === results.length ? "SUCCESS" : successCount === 0 ? "FAILED" : "PARTIAL";
  const task: PublishTask = {
    id,
    status,
    draft: input.draft,
    adapted,
    results,
    logs,
    createdAt: new Date().toISOString()
  };
  tasks.unshift(task);
  return task;
}

export function listPublishTasks(): PublishTask[] {
  return tasks;
}

export function getPublishTask(id: string): PublishTask | undefined {
  return tasks.find((task) => task.id === id);
}

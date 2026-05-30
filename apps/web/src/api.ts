export interface MediaFile {
  name: string;
  url: string;
  type?: string;
}

export interface DraftContent {
  title: string;
  content: string;
  tags: string[];
  images: MediaFile[];
}

export interface AdaptedContent {
  title: string;
  body: string;
  summary: string;
  tags: string[];
  images: MediaFile[];
}

export interface AdaptationResult {
  platformId: string;
  platform: string;
  content: AdaptedContent;
  validation: {
    valid: boolean;
    issues: string[];
  };
}

export interface PublishTask {
  id: string;
  status: "RUNNING" | "SUCCESS" | "FAILED" | "PARTIAL";
  adapted: AdaptationResult[];
  results: Array<{
    platformId: string;
    platform: string;
    status: string;
    message: string;
    publishedUrl?: string;
  }>;
  logs: Array<{
    level: "info" | "warn" | "error";
    message: string;
    createdAt: string;
  }>;
  createdAt: string;
}

export type PublishMode = "browser" | "mock";

export async function fetchAppConfig() {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error("应用配置读取失败");
  return (await response.json()) as { publishMode: PublishMode };
}

export async function adaptContent(draft: DraftContent, platformIds: string[], mode: "ai" | "rules" = "ai") {
  const response = await fetch("/api/adapt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft, platformIds, mode })
  });
  if (!response.ok) throw new Error("内容适配失败");
  return (await response.json()) as { items: AdaptationResult[]; mode: "ai" | "rules"; aiError?: string };
}

export async function publishContent(draft: DraftContent, platformIds: string[], adapted?: AdaptationResult[], mode?: PublishMode) {
  const response = await fetch("/api/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft, platformIds, adapted, mode })
  });
  if (!response.ok) throw new Error("发布任务创建失败");
  return (await response.json()) as PublishTask;
}

export async function fetchPublishTasks() {
  const response = await fetch("/api/tasks");
  if (!response.ok) throw new Error("发布任务刷新失败");
  return (await response.json()) as PublishTask[];
}

export async function openPlatformLogin(platformId: string) {
  const response = await fetch(`/api/accounts/${platformId}/open-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  if (!response.ok) {
    const details = await response.json().catch(() => null);
    throw new Error(details?.error ?? "打开登录页失败");
  }
  return (await response.json()) as { platformId: string; url: string; message: string; connected?: boolean };
}

export async function checkPlatformLogin(platformId: string) {
  const response = await fetch(`/api/accounts/${platformId}/check-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  if (!response.ok) {
    const details = await response.json().catch(() => null);
    throw new Error(details?.error ?? "确认登录态失败");
  }
  return (await response.json()) as { platformId: string; connected: boolean; message: string };
}

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
  status: "SUCCESS" | "FAILED" | "PARTIAL";
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

export async function adaptContent(draft: DraftContent, platformIds: string[]) {
  const response = await fetch("/api/adapt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft, platformIds })
  });
  if (!response.ok) throw new Error("内容适配失败");
  return (await response.json()) as { items: AdaptationResult[] };
}

export async function publishContent(draft: DraftContent, platformIds: string[]) {
  const response = await fetch("/api/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft, platformIds })
  });
  if (!response.ok) throw new Error("发布任务创建失败");
  return (await response.json()) as PublishTask;
}

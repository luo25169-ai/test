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

export interface PlatformLimits {
  titleMax: number;
  bodyMax: number;
  minImages?: number;
  maxTags?: number;
}

export interface ValidationResult {
  valid: boolean;
  issues: string[];
}

export type PublishStatus = "SUCCESS" | "FAILED" | "NEEDS_LOGIN" | "NEEDS_USER_ACTION";

export interface PublishContext {
  taskId: string;
  adaptedContent: AdaptedContent;
  mode: "browser";
}

export interface PublishResult {
  platformId: string;
  platform: string;
  status: PublishStatus;
  message: string;
  publishedUrl?: string;
}

export interface PlatformAdapter {
  id: string;
  name: string;
  type: "article" | "dynamic";
  limits: PlatformLimits;
  formatContent(input: DraftContent): AdaptedContent;
  validate(content: AdaptedContent): ValidationResult;
  publish(context: PublishContext): Promise<PublishResult>;
}

export interface AdaptationResult {
  platformId: string;
  platform: string;
  content: AdaptedContent;
  validation: ValidationResult;
}

import cors from "cors";
import "./env.js";
import express from "express";
import { z } from "zod";
import { adaptForPlatforms, adaptForPlatformsWithAi, getPlatforms } from "./platforms/platform-registry.js";
import { createConfiguredAiAdapter } from "./services/ai-adaptation-service.js";
import { createPublishTask, getPublishTask, listPublishTasks } from "./services/publish-service.js";
import { createZhihuBrowserPublisher } from "./services/zhihu-browser.js";

const zhihuBrowserPublisher = createZhihuBrowserPublisher();

const mediaFileSchema = z.object({
  name: z.string(),
  url: z.string(),
  type: z.string().optional()
});

const draftSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
  images: z.array(mediaFileSchema).default([])
});

const platformIdsSchema = z.array(z.enum(["wechat", "zhihu", "bilibili", "rednote"])).min(1);

export const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "contentflow-server" });
});

app.get("/api/platforms", (_req, res) => {
  res.json(getPlatforms().map(({ id, name, type, limits }) => ({ id, name, type, limits })));
});

app.get("/api/accounts", (_req, res) => {
  res.json([
    { id: "wechat-demo", platformId: "wechat", platformName: "公众号", nickname: "内容创作者", status: "CONNECTED" },
    { id: "zhihu-demo", platformId: "zhihu", platformName: "知乎", nickname: "AI 观察员", status: "CONNECTED" },
    { id: "bilibili-demo", platformId: "bilibili", platformName: "B站", nickname: "效率研究所", status: "CONNECTED" },
    { id: "rednote-demo", platformId: "rednote", platformName: "小红书", nickname: "工具体验官", status: "CONNECTED" }
  ]);
});

app.post("/api/accounts/:platformId/open-login", async (req, res, next) => {
  try {
    const { platformId } = z.object({ platformId: z.enum(["wechat", "zhihu", "bilibili", "rednote"]) }).parse(req.params);
    if (platformId !== "zhihu") {
      res.status(400).json({ error: "暂不支持该平台的自动登录" });
      return;
    }

    const result = await zhihuBrowserPublisher.openLoginPage();
    res.json({ platformId, ...result, message: "已打开知乎登录页，请完成登录后返回 ContentFlow 发布。" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/adapt", async (req, res, next) => {
  try {
    const body = z.object({ draft: draftSchema, platformIds: platformIdsSchema }).parse(req.body);
    const aiAdapter = createConfiguredAiAdapter();
    if (!aiAdapter) {
      res.json({ items: adaptForPlatforms(body.draft, body.platformIds), mode: "rules" });
      return;
    }
    try {
      res.json({
        items: await adaptForPlatformsWithAi(body.draft, body.platformIds, aiAdapter),
        mode: "ai"
      });
    } catch (error) {
      res.json({
        items: adaptForPlatforms(body.draft, body.platformIds),
        mode: "rules",
        aiError: error instanceof Error ? error.message : "AI adaptation failed"
      });
    }
  } catch (error) {
    next(error);
  }
});

app.post("/api/publish", async (req, res, next) => {
  try {
    const body = z.object({ draft: draftSchema, platformIds: platformIdsSchema }).parse(req.body);
    res.status(201).json(await createPublishTask(body, { zhihuPublisher: zhihuBrowserPublisher }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/tasks", (_req, res) => {
  res.json(listPublishTasks());
});

app.get("/api/tasks/:id", (req, res) => {
  const task = getPublishTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json(task);
});

app.get("/api/history", (_req, res) => {
  res.json(listPublishTasks());
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Validation failed", details: error.flatten() });
    return;
  }
  res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
});

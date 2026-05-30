# ContentFlow

ContentFlow 是一个多平台内容发布助手。项目目标是让创作者只写一份内容，系统自动适配公众号、知乎、B站、小红书等平台，并通过发布执行器完成可追踪的一键发布流程。

## 当前进度

- React + Vite 前端工作台
- Express + TypeScript 后端 API
- Prisma + SQLite 数据库模型
- 公众号、知乎、B站、小红书平台 adapter
- 内容适配接口：`POST /api/adapt`
- 发布任务接口：`POST /api/publish`
- 发布任务日志和历史记录骨架
- 真实浏览器发布器与稳定演示模式
- 后端单元测试覆盖 adapter 和发布服务

## 运行方式

```bash
corepack enable pnpm
pnpm install
pnpm dev
```

可选发布模式：

```bash
# browser 使用真实浏览器自动化发布
# mock 使用稳定演示模式，不依赖平台登录态或页面结构
PUBLISH_MODE=mock
```

前端顶部也可以在“真实发布 / 演示模式”之间切换；演示模式会保留完整的适配、发布任务和日志流程，但直接返回模拟成功结果，适合录制答辩视频。

默认地址：

- 前端：http://localhost:5173
- 后端：http://localhost:4000

## 验证命令

```bash
pnpm --filter @contentflow/server test -- --run
pnpm --filter @contentflow/server build
pnpm --filter @contentflow/web build
```

## 项目结构

```txt
apps/
  server/   Express API、平台适配器、发布服务、Prisma schema
  web/      React 前端工作台
artifacts/ 中间产出物、截图、演示素材
docs/      设计文档和实现计划
```

## 真发布说明

当前后端已经把发布流程做成真实任务执行链：适配、校验、调用发布执行器、记录结果和日志。真实发布模式会复用用户浏览器登录态，打开公众号、知乎、B站、小红书创作页并尝试自动填写和发布；演示模式会保留同一套任务和日志链路，但返回稳定的模拟成功结果，避免录制视频时受平台风控、验证码或页面结构变化影响。

## 平台扩展架构

新增平台不需要重写整条发布流程，只需要补齐平台能力并注册：

1. 实现统一 `PlatformAdapter`：负责 `formatContent`、`validate`、`publish`。
2. 注册到 `platformRegistry`：后端统一按平台 ID 查找适配器。
3. 可选接入发布执行器：真实发布走 BrowserExecutor，演示或无账号场景走 MockExecutor。
4. 复用任务日志链路：每个平台都有独立结果、错误原因和任务日志。

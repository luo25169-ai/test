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
- 后端单元测试覆盖 adapter 和发布服务

## 运行方式

```bash
corepack enable pnpm
pnpm install
pnpm dev
```

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

当前后端已经把发布流程做成真实任务执行链：适配、校验、调用发布执行器、记录结果和日志。第一版执行器返回 BrowserExecutor 风格结果，后续会替换为真实浏览器自动化或 Chrome 扩展注入执行器，用用户浏览器已有登录态完成平台页面填写和发布。

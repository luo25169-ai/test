# ContentFlow 多平台内容发布助手设计

## 目标

ContentFlow 是一个面向内容创作者的多平台发布工具。用户只写一份原始内容，系统自动适配公众号、知乎、B站、小红书等平台的格式和风格，并执行一键发布流程。

作品需要体现前后端完整能力，同时优先保证演示视频效果稳定。发布功能不能只做前端假状态：系统必须有真实的发布执行器、任务状态、发布日志和平台结果。

## 参考项目

- MultiPost-Extension: https://github.com/leaperone/MultiPost-Extension
- doocs/md: https://github.com/doocs/md

MultiPost-Extension 作为主参考。它按平台拆分发布逻辑，例如知乎文章、小红书动态、公众号文章等，并通过浏览器扩展在用户已登录的平台页面中填充内容和触发发布。ContentFlow 参考它的平台适配器思想，但不直接复用它的插件工程。

doocs/md 作为编辑器体验参考。它的 Markdown 编辑、公众号排版预览和内容管理思路适合用于 ContentFlow 的编辑页和平台预览页。

## 真发布边界

“真发布”定义为：用户点击发布后，后端创建发布任务，执行平台校验、内容适配、调用具体发布执行器，并保存每个平台的结果和日志。前端展示的进度必须来自后端任务状态，而不是纯前端定时动画。

由于公众号、知乎、B站、小红书这类平台通常不提供适合普通个人项目直接发帖的稳定开放 API，并且账号密码登录存在验证码、二次验证、风控和安全风险，ContentFlow 不保存用户平台明文密码。

ContentFlow 采用两类发布执行器：

1. BrowserExecutor: 真正打开目标平台页面，依赖用户浏览器已有登录态，自动填写内容、上传图片并点击发布。该执行器参考 MultiPost-Extension 的扩展注入方式实现。
2. ApiExecutor: 对未来可接官方 API 或 Webhook 的平台，直接使用 token/API key 发布。课程版本先保留接口，不作为主演示路径。

课程演示中的“发布成功”应来自 BrowserExecutor 或后端执行器返回的真实结果。若某个平台因验证码、风控或页面结构变化无法自动点击最终发布按钮，系统必须把状态标记为 `NEEDS_USER_ACTION`，并给出日志说明，而不是伪造成功。

## 架构

项目由三部分组成：

1. Web 前端
   - React + Vite + TypeScript
   - 负责内容编辑、多平台预览、账号连接、发布任务状态、历史日志展示

2. 后端服务
   - Node.js + Express + TypeScript
   - 负责账号记录、草稿、内容适配、发布任务、发布结果和日志
   - SQLite + Prisma 持久化数据

3. 发布执行器
   - 开发阶段作为本地自动化执行器实现
   - 优先用浏览器已登录态完成真实平台发布
   - 后续可拆成 Chrome 扩展，形成更接近 MultiPost-Extension 的生产方案

## 核心数据流

1. 用户在编辑页输入标题、正文、标签和图片。
2. 用户选择目标平台。
3. 前端调用 `/api/adapt`。
4. 后端调用各平台 adapter，生成平台专属内容。
5. 前端展示公众号、知乎、B站、小红书预览。
6. 用户点击一键发布。
7. 后端创建 publish task。
8. 每个平台进入发布队列。
9. 平台执行器打开发布页面或调用 API。
10. 执行器填写标题、正文、标签、图片。
11. 执行器尝试提交发布。
12. 后端记录成功、失败或需要人工处理。
13. 前端展示实时任务进度和日志。

## 平台适配器接口

每个平台实现同一个接口：

```ts
export interface PlatformAdapter {
  id: string;
  name: string;
  type: "article" | "dynamic";
  limits: PlatformLimits;
  formatContent(input: DraftContent): AdaptedContent;
  validate(content: AdaptedContent): ValidationResult;
  publish(task: PublishContext): Promise<PublishResult>;
}
```

首批平台：

- WeChatAdapter: 公众号长文，强调标题、摘要、封面和富文本排版。
- ZhihuAdapter: 知乎文章，强调观点表达、小标题和专业语气。
- BilibiliAdapter: B站动态/专栏，强调话题标签、简介和社区语气。
- RednoteAdapter: 小红书图文，强调短句、标签和图片。

## 真发布实现方式

第一版优先实现 BrowserExecutor。

执行步骤：

1. 后端收到发布任务。
2. 启动本地浏览器自动化会话。
3. 打开目标平台创作页。
4. 检查是否已登录。
5. 如果未登录，返回 `NEEDS_LOGIN`。
6. 如果已登录，填写标题、正文、标签和图片。
7. 截图或读取页面状态用于确认。
8. 点击发布按钮。
9. 读取发布后提示、URL 或页面状态。
10. 写入发布结果和日志。

结果状态：

- `PENDING`: 等待发布。
- `ADAPTING`: 内容适配中。
- `VALIDATING`: 平台规则校验中。
- `PUBLISHING`: 正在发布。
- `SUCCESS`: 平台确认发布成功。
- `FAILED`: 发布失败。
- `NEEDS_LOGIN`: 需要用户先登录平台。
- `NEEDS_USER_ACTION`: 需要用户处理验证码、二次确认或平台弹窗。

这个设计允许演示真实自动发布，也能在平台风控出现时给出真实、可解释的状态。

## 页面

### 工作台

展示今日草稿数、已连接平台、发布成功率、最近任务。用户可以快速进入编辑页。

### 内容编辑页

左侧是原始内容编辑器，支持标题、正文、标签、图片。中间是平台选择和适配按钮。右侧是多平台预览，可以切换公众号、知乎、B站、小红书。

### 账号管理页

展示平台账号状态。用户可以标记平台账号已连接，也可以点击“打开平台登录页”。系统不保存平台明文密码，只保存平台、账号昵称、授权状态和执行器所需的非敏感配置。

### 发布任务页

展示当前任务队列。每个平台有独立状态、进度、耗时和日志入口。

### 发布历史页

展示历史发布记录，包括原始内容、目标平台、适配版本、最终状态和错误原因。

## 后端接口

```txt
GET  /api/accounts
POST /api/accounts
PATCH /api/accounts/:id

POST /api/drafts
GET  /api/drafts
GET  /api/drafts/:id

POST /api/adapt

POST /api/publish
GET  /api/tasks
GET  /api/tasks/:id
GET  /api/tasks/:id/logs

GET  /api/history
```

## 数据库模型

主要表：

- users
- platform_accounts
- drafts
- adapted_contents
- publish_tasks
- publish_results
- publish_logs

`publish_logs` 必须记录每个发布阶段的真实执行信息，方便演示和答辩说明。

## 错误处理

平台发布存在不稳定因素，系统必须显式处理：

- 未登录：返回 `NEEDS_LOGIN`。
- 验证码或二次确认：返回 `NEEDS_USER_ACTION`。
- 平台页面结构变化：返回 `FAILED`，日志写明未找到页面元素。
- 内容不合规：返回 `VALIDATION_FAILED`，列出超长、缺图片、缺标题等原因。
- 网络异常：任务可重试，日志记录异常信息。

## 测试策略

1. Adapter 单元测试：验证不同平台的格式化和校验规则。
2. API 测试：验证草稿、适配、发布任务、日志接口。
3. 执行器测试：先用本地 mock platform 页面验证自动填写和点击流程。
4. 端到端演示测试：完整跑通写内容、适配、预览、发布、查看日志。

## 演示视频脚本

1. 打开工作台，展示已连接的四个平台。
2. 新建内容，输入一篇原始文章。
3. 点击智能适配，展示四个平台不同版本。
4. 切换预览，说明平台格式差异。
5. 点击一键发布。
6. 发布任务页显示四个平台进入队列。
7. 展示某个平台真实打开发布页并自动填写内容。
8. 返回系统，查看成功、失败或需要人工操作的真实状态。
9. 打开历史页，展示发布日志。

## 取舍

为了保证“真的发布”，系统必须引入浏览器执行器或扩展能力。仅靠普通 Web 后端无法稳定登录并发布到知乎、小红书、B站、公众号等平台。

第一版优先做 Web 前后端加 BrowserExecutor。这样既满足前后端要求，又能展示真实发布动作。后续如果时间允许，再把 BrowserExecutor 拆成 Chrome 扩展，更接近 MultiPost-Extension 的生产形态。

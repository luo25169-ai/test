# ContentFlow Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first runnable full-stack scaffold for ContentFlow with React frontend, Express backend, Prisma SQLite persistence, platform adapters, and a publish-task API.

**Architecture:** Use a pnpm workspace with `apps/web` and `apps/server`. The backend owns platform adaptation, publish task state, database access, and a first BrowserExecutor-compatible publishing interface. The frontend consumes backend APIs to show a polished creator workflow: dashboard, editor, account management, publish tasks, and history.

**Tech Stack:** TypeScript, pnpm workspaces, React, Vite, Tailwind CSS, lucide-react, Express, Prisma, SQLite, Vitest, Supertest.

---

## File Structure

- Create `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `README.md`.
- Create `apps/server` for Express API, Prisma schema, platform adapters, publish service, and tests.
- Create `apps/web` for Vite React app, route-like tab navigation, API client, and UI components.

## Task 1: Workspace And Backend Tests

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.gitignore`
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/vitest.config.ts`
- Create: `apps/server/src/platforms/platform-adapter.test.ts`
- Create: `apps/server/src/services/publish-service.test.ts`

- [x] **Step 1: Write failing tests**

Write backend tests first for platform adaptation and publish task execution. The tests must fail because the implementation files do not exist yet.

- [x] **Step 2: Run tests and verify RED**

Run: `pnpm --filter @contentflow/server test -- --run`

Expected: FAIL because `platform-registry` and `publish-service` modules are missing.

## Task 2: Backend Implementation

**Files:**
- Create: `apps/server/prisma/schema.prisma`
- Create: `apps/server/src/index.ts`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/db.ts`
- Create: `apps/server/src/platforms/types.ts`
- Create: `apps/server/src/platforms/platform-registry.ts`
- Create: `apps/server/src/platforms/adapters.ts`
- Create: `apps/server/src/services/publish-service.ts`

- [x] **Step 1: Implement adapters and publish service**

Implement four adapters: WeChat, Zhihu, Bilibili, and Rednote. Each adapter formats content, validates platform rules, and returns publish results through the service.

- [x] **Step 2: Run backend tests and verify GREEN**

Run: `pnpm --filter @contentflow/server test -- --run`

Expected: PASS.

## Task 3: Frontend Scaffold

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/index.html`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/tailwind.config.ts`
- Create: `apps/web/postcss.config.js`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/styles.css`
- Create: `apps/web/src/api.ts`

- [x] **Step 1: Build React UI**

Create a runnable UI with dashboard, editor, account, task, and history views. The editor calls backend adapt and publish endpoints.

- [x] **Step 2: Build frontend**

Run: `pnpm --filter @contentflow/web build`

Expected: PASS.

## Task 4: Integration Verification And Push

**Files:**
- Modify: `README.md`

- [x] **Step 1: Install dependencies**

Run: `pnpm install`.

- [x] **Step 2: Run verification**

Run:

```bash
pnpm --filter @contentflow/server test -- --run
pnpm --filter @contentflow/web build
pnpm --filter @contentflow/server build
```

Expected: all commands pass.

- [x] **Step 3: Commit and push**

Run:

```bash
git add .
git commit -m "Scaffold ContentFlow full-stack app"
git push
```

Expected: GitHub receives the scaffold.

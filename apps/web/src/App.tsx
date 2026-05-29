import {
  BarChart3,
  CheckCircle2,
  Clock3,
  FileText,
  History,
  LayoutDashboard,
  Link2,
  Loader2,
  Megaphone,
  Send,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import { useMemo, useState } from "react";
import type { AdaptationResult, DraftContent, PublishTask } from "./api";
import { adaptContent, publishContent } from "./api";

type View = "dashboard" | "editor" | "accounts" | "tasks" | "history";

const platforms = [
  { id: "wechat", name: "公众号", tone: "长文排版", color: "bg-emerald-100 text-emerald-700" },
  { id: "zhihu", name: "知乎", tone: "专业观点", color: "bg-blue-100 text-blue-700" },
  { id: "bilibili", name: "B站", tone: "社区动态", color: "bg-pink-100 text-pink-700" },
  { id: "rednote", name: "小红书", tone: "种草短句", color: "bg-rose-100 text-rose-700" }
];

const initialDraft: DraftContent = {
  title: "AI 工具提升内容创作效率",
  content:
    "今天测试一款 AI 内容工具。它可以根据不同平台生成对应版本，并帮助创作者减少重复排版工作。用户只需要写一份原始内容，系统会自动生成适合公众号、知乎、B站和小红书的版本。",
  tags: ["AI", "效率", "内容创作"],
  images: [{ name: "cover.png", url: "https://example.com/cover.png", type: "image/png" }]
};

function classNames(...items: Array<string | false | undefined>) {
  return items.filter(Boolean).join(" ");
}

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [draft, setDraft] = useState<DraftContent>(initialDraft);
  const [selectedPlatforms, setSelectedPlatforms] = useState(platforms.map((platform) => platform.id));
  const [adapted, setAdapted] = useState<AdaptationResult[]>([]);
  const [tasks, setTasks] = useState<PublishTask[]>([]);
  const [activePreview, setActivePreview] = useState("wechat");
  const [loading, setLoading] = useState<"adapt" | "publish" | null>(null);
  const [error, setError] = useState("");

  const activeContent = useMemo(
    () => adapted.find((item) => item.platformId === activePreview) ?? adapted[0],
    [activePreview, adapted]
  );

  async function handleAdapt() {
    setError("");
    setLoading("adapt");
    try {
      const response = await adaptContent(draft, selectedPlatforms);
      setAdapted(response.items);
      setActivePreview(response.items[0]?.platformId ?? "wechat");
      setView("editor");
    } catch (err) {
      setError(err instanceof Error ? err.message : "内容适配失败");
    } finally {
      setLoading(null);
    }
  }

  async function handlePublish() {
    setError("");
    setLoading("publish");
    try {
      const task = await publishContent(draft, selectedPlatforms);
      setTasks((current) => [task, ...current]);
      setAdapted(task.adapted);
      setView("tasks");
    } catch (err) {
      setError(err instanceof Error ? err.message : "发布失败");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <aside className="fixed inset-y-0 left-0 w-64 border-r border-line bg-white px-4 py-5">
        <div className="mb-8 flex items-center gap-3 px-2">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-ink text-white">
            <Sparkles size={22} />
          </div>
          <div>
            <div className="text-lg font-semibold">ContentFlow</div>
            <div className="text-xs text-muted">多平台内容发布助手</div>
          </div>
        </div>
        <nav className="space-y-1">
          {[
            ["dashboard", LayoutDashboard, "工作台"],
            ["editor", FileText, "内容编辑"],
            ["accounts", ShieldCheck, "账号管理"],
            ["tasks", Clock3, "发布任务"],
            ["history", History, "发布历史"]
          ].map(([id, Icon, label]) => (
            <button
              key={id as string}
              onClick={() => setView(id as View)}
              className={classNames(
                "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition",
                view === id ? "bg-ink text-white" : "text-slate-600 hover:bg-slate-100"
              )}
            >
              <Icon size={18} />
              {label as string}
            </button>
          ))}
        </nav>
      </aside>

      <main className="ml-64 px-8 py-6">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">创作者发布工作台</h1>
            <p className="text-sm text-muted">一份内容，多平台适配，发布过程可追踪。</p>
          </div>
          <button
            onClick={handlePublish}
            disabled={loading !== null}
            className="inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {loading === "publish" ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />}
            一键发布
          </button>
        </header>

        {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

        {view === "dashboard" && (
          <section className="space-y-6">
            <div className="grid grid-cols-4 gap-4">
              {[
                ["已连接平台", "4", Link2],
                ["草稿内容", "1", FileText],
                ["发布任务", String(tasks.length), Megaphone],
                ["成功率", tasks.length ? "实时" : "待发布", BarChart3]
              ].map(([label, value, Icon]) => (
                <div key={label as string} className="rounded-lg border border-line bg-white p-5">
                  <Icon className="mb-4 text-slate-500" size={22} />
                  <div className="text-2xl font-semibold">{value as string}</div>
                  <div className="text-sm text-muted">{label as string}</div>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-line bg-white p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">推荐演示流程</h2>
                <button onClick={() => setView("editor")} className="rounded-md border border-line px-3 py-2 text-sm">
                  进入编辑
                </button>
              </div>
              <div className="grid grid-cols-4 gap-3 text-sm">
                {["写入原始内容", "生成平台版本", "执行真实发布器", "查看日志结果"].map((item, index) => (
                  <div key={item} className="rounded-md bg-slate-50 p-4">
                    <div className="mb-2 text-xs text-muted">Step {index + 1}</div>
                    <div className="font-medium">{item}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {view === "editor" && (
          <section className="grid grid-cols-[1fr_360px] gap-5">
            <div className="space-y-4">
              <div className="rounded-lg border border-line bg-white p-5">
                <label className="mb-2 block text-sm font-medium">标题</label>
                <input
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                  className="mb-4 w-full rounded-md border border-line px-3 py-2"
                />
                <label className="mb-2 block text-sm font-medium">正文</label>
                <textarea
                  value={draft.content}
                  onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                  className="h-56 w-full resize-none rounded-md border border-line px-3 py-2 leading-7"
                />
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <input
                    value={draft.tags.join("，")}
                    onChange={(event) =>
                      setDraft({ ...draft, tags: event.target.value.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean) })
                    }
                    className="rounded-md border border-line px-3 py-2"
                    placeholder="标签，用逗号分隔"
                  />
                  <input
                    value={draft.images[0]?.url ?? ""}
                    onChange={(event) =>
                      setDraft({ ...draft, images: [{ name: "cover.png", url: event.target.value, type: "image/png" }] })
                    }
                    className="rounded-md border border-line px-3 py-2"
                    placeholder="图片 URL"
                  />
                </div>
              </div>
              <div className="rounded-lg border border-line bg-white p-5">
                <div className="mb-3 text-sm font-medium">目标平台</div>
                <div className="flex flex-wrap gap-2">
                  {platforms.map((platform) => (
                    <button
                      key={platform.id}
                      onClick={() =>
                        setSelectedPlatforms((current) =>
                          current.includes(platform.id)
                            ? current.filter((id) => id !== platform.id)
                            : [...current, platform.id]
                        )
                      }
                      className={classNames(
                        "rounded-md border px-3 py-2 text-sm",
                        selectedPlatforms.includes(platform.id) ? "border-ink bg-ink text-white" : "border-line bg-white"
                      )}
                    >
                      {platform.name} · {platform.tone}
                    </button>
                  ))}
                </div>
                <div className="mt-4 flex gap-3">
                  <button
                    onClick={handleAdapt}
                    disabled={loading !== null}
                    className="inline-flex items-center gap-2 rounded-md border border-line px-4 py-2 text-sm"
                  >
                    {loading === "adapt" ? <Loader2 className="animate-spin" size={16} /> : <Sparkles size={16} />}
                    智能适配
                  </button>
                  <button onClick={handlePublish} className="inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-sm text-white">
                    <Send size={16} />
                    发布
                  </button>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-line bg-white p-5">
              <div className="mb-4 flex gap-2 overflow-x-auto">
                {(adapted.length ? adapted : platforms.map((platform) => ({ platformId: platform.id, platform: platform.name }))).map((item) => (
                  <button
                    key={item.platformId}
                    onClick={() => setActivePreview(item.platformId)}
                    className={classNames(
                      "shrink-0 rounded-md px-3 py-2 text-sm",
                      activePreview === item.platformId ? "bg-ink text-white" : "bg-slate-100 text-slate-600"
                    )}
                  >
                    {item.platform}
                  </button>
                ))}
              </div>
              {activeContent ? (
                <div>
                  <div className="mb-3 flex items-center gap-2">
                    {activeContent.validation.valid ? (
                      <CheckCircle2 className="text-emerald-600" size={18} />
                    ) : (
                      <ShieldCheck className="text-amber-600" size={18} />
                    )}
                    <span className="text-sm text-muted">{activeContent.validation.valid ? "校验通过" : "需要调整"}</span>
                  </div>
                  <h2 className="mb-3 text-xl font-semibold">{activeContent.content.title}</h2>
                  <p className="mb-4 rounded-md bg-slate-50 p-3 text-sm text-muted">{activeContent.content.summary}</p>
                  <div className="whitespace-pre-wrap rounded-md border border-line p-4 text-sm leading-7">{activeContent.content.body}</div>
                </div>
              ) : (
                <div className="grid h-80 place-items-center rounded-md border border-dashed border-line text-sm text-muted">
                  点击智能适配后预览平台版本
                </div>
              )}
            </div>
          </section>
        )}

        {view === "accounts" && (
          <section className="grid grid-cols-2 gap-4">
            {platforms.map((platform) => (
              <div key={platform.id} className="rounded-lg border border-line bg-white p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h2 className="font-semibold">{platform.name}</h2>
                    <p className="text-sm text-muted">{platform.tone} · 已连接演示账号</p>
                  </div>
                  <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs text-emerald-700">CONNECTED</span>
                </div>
                <button className="rounded-md border border-line px-3 py-2 text-sm">打开平台登录页</button>
              </div>
            ))}
          </section>
        )}

        {view === "tasks" && (
          <section className="space-y-4">
            {tasks.length === 0 && <EmptyState text="暂无发布任务，先在编辑页点击发布。" />}
            {tasks.map((task) => (
              <div key={task.id} className="rounded-lg border border-line bg-white p-5">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h2 className="font-semibold">任务 {task.id.slice(0, 8)}</h2>
                    <p className="text-sm text-muted">{new Date(task.createdAt).toLocaleString()}</p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-sm">{task.status}</span>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  {task.results.map((result) => (
                    <div key={result.platformId} className="rounded-md bg-slate-50 p-3 text-sm">
                      <div className="mb-1 font-medium">{result.platform}</div>
                      <div className={result.status === "SUCCESS" ? "text-emerald-700" : "text-red-700"}>{result.status}</div>
                      <p className="mt-2 text-xs text-muted">{result.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}

        {view === "history" && (
          <section className="rounded-lg border border-line bg-white p-5">
            <h2 className="mb-4 text-lg font-semibold">发布日志</h2>
            {tasks.length === 0 && <EmptyState text="暂无历史记录。" />}
            {tasks.flatMap((task) =>
              task.logs.map((log) => (
                <div key={`${task.id}-${log.createdAt}-${log.message}`} className="border-b border-line py-3 text-sm last:border-0">
                  <span className="mr-3 rounded bg-slate-100 px-2 py-1 text-xs">{log.level}</span>
                  {log.message}
                </div>
              ))
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="grid h-48 place-items-center rounded-lg border border-dashed border-line bg-white text-sm text-muted">{text}</div>;
}

/**
 * 本地后端服务 v2（需求 3/14/16/17）：
 * - 只监听 127.0.0.1；每次启动生成随机访问令牌（16.2），所有 /api 接口与事件流必须带令牌
 *   （Cookie dispatch_token / 请求头 x-dispatch-token / 查询参数 ?token= 三选一）。
 * - 校验 Host 与 Origin 只接受本机地址，防本地网页攻击；无令牌/来源不合法一律拒绝。
 * - 路由表以「方法 + 路径」集中声明（14.1）；路径存在但方法不对 → 405 并说明允许的方法，
 *   一律不返回 404「未知接口」；统一响应 {ok,data} / {ok,code,message,detail}（14.4）。
 * - 目录浏览接口只读返回目录名（13.3，网页拿不到本地绝对路径）；Windows 列盘符。
 * - 诊断包导出（17）：全部脱敏，不含密钥。
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { URL } from "node:url";
import {
  getConfig,
  loadConfig,
  sanitizedConfig,
  saveConfig,
  loadProjects,
  saveProjects,
  ProjectEntry,
} from "./config";
import { testConnection } from "./llm/openai";
import { publish, subscribe, recentEvents, eventsSince, UiEvent } from "./events";
import { orchestrator, ProjectRuntime, taskView } from "./orchestrator";
import { runEnvCheck, cancelInstall, activeInstallIds, startFix, ensurePortableBrowserEnv, CheckResult } from "./envcheck/check";
import { PolicyLedger } from "./policy/permissions";
import { appRoot, dataDir, safeJoin, toolsDir } from "./util/paths";
import { info, warn, error as logError, readRecentLogs, redact } from "./logger";
import { SLOT_STATUSES } from "./tasks/store";
import { heartbeat } from "./heartbeat";
import { memory } from "./memory/memory";
import { listMcpServers, addMcpServer, removeMcpServer, toggleMcpServer, testMcpServer, previewSkillsImport, importSkills } from "./toolhub/toolhub";

// ───────────────────────── 错误码表与统一响应（14.4） ─────────────────────────

export const ERROR_CODES = {
  UNAUTHORIZED: "缺少或无效的访问令牌，请通过 start.sh 打开界面",
  BAD_ORIGIN: "请求来源不受信任，已拒绝",
  NOT_FOUND: "接口不存在",
  METHOD_NOT_ALLOWED: "该方法不被允许",
  BAD_REQUEST: "请求参数有误",
  PROJECT_CONFLICT: "目录与已添加的项目冲突",
  SYSTEM_DIR: "该目录是系统目录，不能作为项目目录",
  TASK_STATE: "任务当前状态不允许该操作",
  INTERNAL: "服务内部错误",
} as const;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(buf) });
  res.end(buf);
}

function ok(res: http.ServerResponse, data: unknown): void {
  json(res, 200, { ok: true, data });
}

function fail(res: http.ServerResponse, status: number, code: keyof typeof ERROR_CODES, detail?: string): void {
  json(res, status, { ok: false, code, message: ERROR_CODES[code], detail });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ───────────────────────── 访问令牌与来源校验（16.2） ─────────────────────────

/** 本次启动的随机令牌；写入 runtime.json 供 start.sh 拼接带令牌的打开地址。 */
let ACCESS_TOKEN = "";

function ensureToken(): string {
  if (!ACCESS_TOKEN) ACCESS_TOKEN = crypto.randomBytes(24).toString("base64url");
  return ACCESS_TOKEN;
}

function tokenOf(req: http.IncomingMessage, url: URL): string {
  const header = req.headers["x-dispatch-token"];
  if (typeof header === "string" && header) return header;
  const cookie = req.headers.cookie ?? "";
  const m = cookie.match(/(?:^|;\s*)dispatch_token=([^;]+)/);
  if (m) return decodeURIComponent(m[1]);
  const q = url.searchParams.get("token");
  return q ?? "";
}

function isLocalHost(host: string): boolean {
  const h = (host ?? "").split(":")[0];
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
}

/** Host 与 Origin 都必须指向本机（16.2）。 */
function originAllowed(req: http.IncomingMessage, url: URL): boolean {
  if (!isLocalHost(req.headers.host ?? "")) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // 无 Origin（curl/同源 GET）只要令牌合法
  try {
    const o = new URL(origin);
    const self = new URL(`${url.protocol}//${req.headers.host}`);
    return o.protocol === self.protocol && isLocalHost(o.host) && o.port === self.port;
  } catch {
    return false;
  }
}

// ───────────────────────── SSE ─────────────────────────

function startSse(res: http.ServerResponse): (e: unknown) => void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  const hb = setInterval(() => {
    try {
      res.write(": hb\n\n");
    } catch {
      /* ignore */
    }
  }, 15000);
  res.on("close", () => clearInterval(hb));
  return (e: unknown) => {
    try {
      const id = (e as any)?.id;
      // L9：SSE 帧带 id 行，前端按 id 去重并以 lastEventId 重连补发
      res.write(id !== undefined ? `id: ${id}\ndata: ${JSON.stringify(e)}\n\n` : `data: ${JSON.stringify(e)}\n\n`);
    } catch {
      /* ignore */
    }
  };
}

/** 事件流端点（L9）：带 lastEventId 时只补发缺失事件，客户端按 id 去重。 */
function eventsEndpoint(res: http.ServerResponse, url: URL): void {
  const write = startSse(res);
  const last = parseInt(url.searchParams.get("lastEventId") ?? "", 10);
  const backlog = Number.isFinite(last) ? eventsSince(last) : recentEvents();
  for (const e of backlog) write(e);
  const unsub = subscribe((e: UiEvent) => write(e));
  res.on("close", unsub);
}

// ───────────────────────── 静态文件与项目预览 ─────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, url: URL): boolean {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.join(appRoot(), "public", rel);
  if (!file.startsWith(path.join(appRoot(), "public"))) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const ext = path.extname(file).toLowerCase();
    // 首次带令牌打开页面时种下 Cookie，后续请求自动携带（16.2）
    if (url.searchParams.get("token")) {
      res.setHeader("Set-Cookie", `dispatch_token=${encodeURIComponent(url.searchParams.get("token")!)}; Path=/; HttpOnly; SameSite=Strict`);
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
      return true;
    }
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

/** 项目静态预览（验收标准 url 形如 http://127.0.0.1:<port>/preview/index.html）。 */
function servePreview(res: http.ServerResponse, url: URL): void {
  const projectDir = url.searchParams.get("project") ?? orchestrator.projectDirs[0];
  const rt = projectDir ? orchestrator.getRuntime(projectDir) : undefined;
  if (!rt) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("未找到可预览的项目");
    return;
  }
  const rel = decodeURIComponent(url.pathname.slice("/preview/".length)) || "index.html";
  const file = safeJoin(rt.projectDir, rel);
  const candidates = [file, safeJoin(rt.projectDir, path.join(rel, "index.html"))];
  for (const f of candidates) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { "Content-Type": MIME[path.extname(f).toLowerCase()] ?? "application/octet-stream" });
      fs.createReadStream(f).pipe(res);
      return;
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("预览文件不存在");
}

// ───────────────────────── 目录浏览（13.3） ─────────────────────────

/** 系统目录清单（与 15.3 硬拦截同一取材，防止把系统目录加为项目）。 */
function isSystemDir(p: string): boolean {
  const norm = path.resolve(p).toLowerCase();
  if (norm === path.resolve("/") ) return true;
  if (norm === path.resolve(appRoot())) return true; // 调度中心自身程序目录
  if (process.platform === "win32") {
    const sys = [path.resolve(process.env.SystemRoot ?? "C:\\Windows").toLowerCase(), path.resolve("C:\\Program Files").toLowerCase(), path.resolve("C:\\Program Files (x86)").toLowerCase(), path.resolve("C:\\ProgramData").toLowerCase()];
    if (sys.some((s) => norm === s || norm.startsWith(s + path.sep))) return true;
    if (norm === path.resolve(os.homedir()).toLowerCase()) return true;
    return false;
  }
  const tops = ["/etc", "/usr", "/bin", "/sbin", "/var", "/boot", "/dev", "/proc", "/sys", "/lib", "/opt", "/root"];
  if (tops.some((s) => norm === s || norm.startsWith(s + "/"))) return true;
  if (norm === path.resolve(os.homedir())) return true;
  return false;
}

function listDirForBrowse(dir: string): { path: string; parent: string | null; dirs: string[]; drives?: string[] } {
  // Windows 根：列盘符
  if (process.platform === "win32" && (!dir || dir === "/" || dir === "\\")) {
    const drives: string[] = [];
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const d = `${letter}:\\`;
      try {
        if (fs.existsSync(d)) drives.push(d);
      } catch {
        /* ignore */
      }
    }
    return { path: "", parent: null, dirs: [], drives };
  }
  const abs = path.resolve(dir);
  const entries = fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => path.join(abs, e.name))
    .sort();
  const parent = path.dirname(abs) === abs ? null : path.dirname(abs);
  return { path: abs, parent, dirs: entries };
}

// ───────────────────────── 路由表（14.1/14.2） ─────────────────────────

type Ctx = { req: http.IncomingMessage; res: http.ServerResponse; url: URL; body: any; params: Record<string, string> };
type Route = { method: string; pathPattern: string; handler: (ctx: Ctx) => Promise<void> | void };

const ROUTES: Route[] = [];
function route(method: string, pathPattern: string, handler: (ctx: Ctx) => Promise<void> | void): void {
  ROUTES.push({ method, pathPattern, handler });
}

/** 编译 "/api/tasks/:id/pause" → 段匹配器。 */
function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const ps = pattern.split("/").filter(Boolean);
  const xs = pathname.split("/").filter(Boolean);
  if (ps.length !== xs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(":")) params[ps[i].slice(1)] = decodeURIComponent(xs[i]);
    else if (ps[i] !== xs[i]) return null;
  }
  return params;
}

/** 契约测试用：返回声明的路由表（方法 + 路径模式）。 */
export function routeTable(): { method: string; path: string }[] {
  return ROUTES.map((r) => ({ method: r.method, path: r.pathPattern }));
}

function requiredString(body: any, key: string): string {
  const v = body?.[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`缺少必填参数 ${key}`);
  return v.trim();
}

// ───────────────────────── 项目与任务辅助 ─────────────────────────

function projectRuntimeOr404(ctx: Ctx): ProjectRuntime | undefined {
  const dir = ctx.url.searchParams.get("project") ?? ctx.body?.project ?? ctx.params.project;
  if (!dir) {
    fail(ctx.res, 400, "BAD_REQUEST", "缺少 project 参数（项目目录）");
    return undefined;
  }
  const rt = orchestrator.getRuntime(dir) ?? (fs.existsSync(path.resolve(dir)) ? orchestrator.ensureProject(dir) : undefined);
  if (!rt) {
    fail(ctx.res, 404, "NOT_FOUND", `项目不存在：${dir}`);
    return undefined;
  }
  return rt;
}

// ───────────────────────── 接口声明 ─────────────────────────

route("GET", "/api/health", (ctx) => {
  ok(ctx.res, { version: "2.0.0", tokenRequired: true });
});

route("GET", "/api/state", (ctx) => {
  const cfg = getConfig();
  const projects = loadProjects().map((p) => {
    const rt = orchestrator.getRuntime(p.path) ?? orchestrator.ensureProject(p.path);
    const tasks = rt.store.list();
    return {
      path: rt.projectDir,
      name: p.name,
      startCommand: p.startCommand ?? "",
      busy: rt.busy,
      taskCount: tasks.length,
      tasks: tasks.map((t) => taskView(t)),
    };
  });
  ok(ctx.res, {
    config: sanitizedConfig(),
    permissionRules: PolicyLedger.describe(),
    projects,
    cards: orchestrator.projectDirs.flatMap((d) => orchestrator.getOpenCards(d).map((c) => ({ ...c, projectDir: d }))),
    autoApprovals: orchestrator.ledger.records.slice(-200),
    watchdog: orchestrator.getWatchdogUsage(),
    heartbeat: heartbeat.lastRecord() ?? null,
    envcheckInstalls: activeInstallIds(),
    currentEventId: recentEvents().length ? recentEvents()[recentEvents().length - 1].id : 0,
    platform: process.platform,
  });
});

route("GET", "/api/events", (ctx) => {
  eventsEndpoint(ctx.res, ctx.url);
});

// 配置
route("GET", "/api/config", (ctx) => {
  ok(ctx.res, { config: sanitizedConfig() });
});

route("POST", "/api/config", (ctx) => {
  saveConfig(ctx.body ?? {});
  ok(ctx.res, { config: sanitizedConfig() });
});

route("POST", "/api/config/test-brain", async (ctx) => {
  const cfg = getConfig();
  const r = await testConnection(cfg.brain.baseUrl, cfg.brain.apiKey, cfg.brain.model);
  ok(ctx.res, r);
});

// 项目
route("GET", "/api/projects", (ctx) => {
  ok(ctx.res, { projects: loadProjects() });
});

route("POST", "/api/projects", async (ctx) => {
  const dir = requiredString(ctx.body, "path");
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) {
    try {
      fs.mkdirSync(abs, { recursive: true });
    } catch (e: any) {
      fail(ctx.res, 400, "BAD_REQUEST", `无法创建目录：${e.message}`);
      return;
    }
  }
  if (isSystemDir(abs)) {
    fail(ctx.res, 400, "SYSTEM_DIR");
    return;
  }
  // 冲突校验（13.3）：不能是已添加项目的父目录或子目录
  const list = loadProjects();
  for (const p of list) {
    const existing = path.resolve(p.path);
    if (existing === abs || existing.startsWith(abs + path.sep) || abs.startsWith(existing + path.sep)) {
      fail(ctx.res, 409, "PROJECT_CONFLICT", `与已添加项目「${p.name}」重叠：${p.path}`);
      return;
    }
  }
  // 可写校验
  try {
    const probe = path.join(abs, `.dispatch-write-probe-${Date.now()}`);
    fs.writeFileSync(probe, "x");
    fs.rmSync(probe);
  } catch {
    fail(ctx.res, 400, "BAD_REQUEST", "目录不可写");
    return;
  }
  const entry: ProjectEntry = { path: abs, name: path.basename(abs), startCommand: ctx.body?.startCommand ?? undefined, createdAt: new Date().toISOString() };
  list.push(entry);
  saveProjects(list);
  orchestrator.addProject(abs);
  info("api", `新增项目: ${abs}`);
  ok(ctx.res, { path: abs });
});

route("DELETE", "/api/projects/:project", (ctx) => {
  const r = orchestrator.removeProject(ctx.params.project);
  if (!r.ok) {
    fail(ctx.res, 409, "TASK_STATE", r.detail);
    return;
  }
  ok(ctx.res, {});
});

route("POST", "/api/projects/:project/settings", (ctx) => {
  const list = loadProjects();
  const entry = list.find((p) => path.resolve(p.path) === path.resolve(ctx.params.project));
  if (!entry) {
    fail(ctx.res, 404, "NOT_FOUND", "项目不存在");
    return;
  }
  if (typeof ctx.body?.startCommand === "string") entry.startCommand = ctx.body.startCommand.trim();
  if (typeof ctx.body?.name === "string" && ctx.body.name.trim()) entry.name = ctx.body.name.trim();
  saveProjects(list);
  ok(ctx.res, { entry });
});

// 目录浏览
route("GET", "/api/fs/list", (ctx) => {
  try {
    const dir = ctx.url.searchParams.get("path") ?? "";
    ok(ctx.res, listDirForBrowse(dir));
  } catch (e: any) {
    fail(ctx.res, 400, "BAD_REQUEST", `无法读取目录：${e.message}`);
  }
});

route("POST", "/api/fs/mkdir", (ctx) => {
  try {
    const parent = requiredString(ctx.body, "path");
    const name = requiredString(ctx.body, "name");
    if (/[\\/:*?"<>|]/.test(name)) {
      fail(ctx.res, 400, "BAD_REQUEST", "文件夹名称包含非法字符");
      return;
    }
    const full = path.join(path.resolve(parent), name);
    fs.mkdirSync(full, { recursive: false });
    ok(ctx.res, { path: full });
  } catch (e: any) {
    fail(ctx.res, 400, "BAD_REQUEST", `创建文件夹失败：${e.message}`);
  }
});

// 会话
route("GET", "/api/sessions", (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  orchestrator.ensureSession(rt);
  ok(ctx.res, { sessions: rt.sessions.listSessions(), activeId: rt.sessions.activeId });
});

route("POST", "/api/sessions", (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  const id = orchestrator.startNewSession(rt);
  ok(ctx.res, { sessionId: id });
});

route("POST", "/api/sessions/:id/open", (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  try {
    rt.sessions.open(ctx.params.id);
    ok(ctx.res, {});
  } catch (e: any) {
    fail(ctx.res, 404, "NOT_FOUND", e.message);
  }
});

route("POST", "/api/sessions/:id/archive", (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  rt.sessions.archive(ctx.params.id);
  ok(ctx.res, {});
});

route("DELETE", "/api/sessions/:id", (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  const permanent = ctx.url.searchParams.get("permanent") === "1";
  const r = rt.sessions.deleteSession(ctx.params.id, permanent);
  ok(ctx.res, r);
});

route("GET", "/api/sessions/:id/messages", (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  const usage = rt.sessions.contextUsage(ctx.params.id, getConfig().brain.maxContextTokens);
  ok(ctx.res, { lines: rt.sessions.read(ctx.params.id), usage });
});

// 聊天（SSE 流式回复）
route("POST", "/api/chat", (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  const message = requiredString(ctx.body, "message");
  const write = startSse(ctx.res);
  const requestId = typeof ctx.body?.requestId === "string" ? ctx.body.requestId : undefined;
  orchestrator
    // M10：同一端点 + 同一 requestId 的连点只执行一次（不同端点的 requestId 互不影响）
    .dedupe(requestId ? `chat:${requestId}` : undefined, () => orchestrator.handleUserMessage(rt.projectDir, message, (t) => write({ type: "chat-delta", sessionId: rt.sessions.activeId, text: t })))
    .then(() => {
      write({ type: "chat-done" });
      ctx.res.end();
    })
    .catch((e: any) => {
      write({ type: "chat-done", error: e?.message ?? String(e) });
      ctx.res.end();
    });
});

// 任务
route("GET", "/api/tasks", (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  ok(ctx.res, { tasks: rt.store.list().map((t) => taskView(t)), loops: Object.fromEntries(rt.store.list().map((t) => [t.id, t.loops])) });
});

route("POST", "/api/tasks/:id/pause", (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  const task = rt.store.get(ctx.params.id);
  if (!task) return fail(ctx.res, 404, "NOT_FOUND", "任务不存在");
  if (!SLOT_STATUSES.includes(task.status) && task.status !== "queued") {
    fail(ctx.res, 409, "TASK_STATE", `任务当前为 ${task.status}，无法暂停`);
    return;
  }
  orchestrator.pauseTask(rt, task, "使用者暂停");
  ok(ctx.res, {});
});

route("POST", "/api/tasks/:id/resume", (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  const task = rt.store.get(ctx.params.id);
  if (!task) return fail(ctx.res, 404, "NOT_FOUND", "任务不存在");
  const r = orchestrator.resumeTask(rt, task);
  if (!r.ok) fail(ctx.res, 409, "TASK_STATE", r.detail);
  else ok(ctx.res, {});
});

route("POST", "/api/tasks/:id/cancel", (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  const task = rt.store.get(ctx.params.id);
  if (!task) return fail(ctx.res, 404, "NOT_FOUND", "任务不存在");
  const r = orchestrator.cancelTask(rt, task);
  if (!r.ok) fail(ctx.res, 409, "TASK_STATE", r.detail);
  else ok(ctx.res, {});
});

route("POST", "/api/tasks/:id/remove", (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  const task = rt.store.get(ctx.params.id);
  if (!task) return fail(ctx.res, 404, "NOT_FOUND", "任务不存在");
  const r = orchestrator.removeTask(rt, task);
  if (!r.ok) fail(ctx.res, 409, "TASK_STATE", r.detail);
  else ok(ctx.res, {});
});

route("POST", "/api/tasks/:id/rollback", async (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  const task = rt.store.get(ctx.params.id);
  if (!task) return fail(ctx.res, 404, "NOT_FOUND", "任务不存在");
  const r = await orchestrator.rollbackTask(rt, task);
  if (!r.ok) fail(ctx.res, 409, "TASK_STATE", r.detail);
  else ok(ctx.res, { detail: r.detail });
});

// 决策卡片
route("GET", "/api/cards", (ctx) => {
  const dir = ctx.url.searchParams.get("project");
  const cards = dir
    ? orchestrator.getOpenCards(dir).map((c) => ({ ...c, projectDir: dir }))
    : orchestrator.projectDirs.flatMap((d) => orchestrator.getOpenCards(d).map((c) => ({ ...c, projectDir: d })));
  ok(ctx.res, { cards });
});

route("POST", "/api/cards/:id/confirm", async (ctx) => {
  const dir = ctx.body?.project ?? ctx.url.searchParams.get("project") ?? orchestrator.projectDirs[0];
  if (!dir) return fail(ctx.res, 400, "BAD_REQUEST", "缺少 project");
  // M10：同一 requestId 的连点只执行一次
  const requestId = typeof ctx.body?.requestId === "string" ? ctx.body.requestId : undefined;
  await orchestrator.dedupe(requestId ? `confirm:${requestId}` : undefined, () => orchestrator.confirmRequirement(dir, ctx.params.id));
  ok(ctx.res, {});
});

route("POST", "/api/cards/:id/answer", async (ctx) => {
  const dir = ctx.body?.project ?? ctx.url.searchParams.get("project") ?? orchestrator.projectDirs[0];
  if (!dir) return fail(ctx.res, 400, "BAD_REQUEST", "缺少 project");
  const choice = typeof ctx.body?.choice === "string" ? ctx.body.choice : typeof ctx.body?.text === "string" ? ctx.body.text : "";
  if (!choice) return fail(ctx.res, 400, "BAD_REQUEST", "缺少 choice/text");
  await orchestrator.decide(dir, ctx.params.id, choice);
  ok(ctx.res, {});
});

// 记忆（9.4/9.5：读、改、删）
route("GET", "/api/memory", (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  const scope = (ctx.url.searchParams.get("scope") === "global" ? "global" : "project") as "project" | "global";
  ok(ctx.res, { scope, raw: memory.readRaw(scope, 8192) });
});

route("POST", "/api/memory", (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  const scope = (ctx.body?.scope === "global" ? "global" : "project") as "project" | "global";
  const r = memory.editEntry(scope, ctx.body?.id ?? null, typeof ctx.body?.text === "string" ? ctx.body.text : null);
  if (!r.ok) fail(ctx.res, 400, "BAD_REQUEST", r.error);
  else ok(ctx.res, {});
});

route("DELETE", "/api/memory", (ctx) => {
  const rt = projectRuntimeOr404(ctx);
  if (!rt) return;
  const scope = (ctx.body?.scope === "global" ? "global" : "project") as "project" | "global";
  const r = memory.editEntry(scope, ctx.body?.id ?? null, null);
  if (!r.ok) fail(ctx.res, 400, "BAD_REQUEST", r.error);
  else ok(ctx.res, {});
});

// 环境
route("POST", "/api/envcheck", async (ctx) => {
  const results = await runEnvCheck();
  lastEnvCheck = results;
  publish({ type: "envcheck", results });
  ok(ctx.res, { results });
});

route("GET", "/api/envcheck", (ctx) => {
  ok(ctx.res, { results: lastEnvCheck, installs: activeInstallIds() });
});

route("POST", "/api/envcheck/install", (ctx) => {
  const tool = requiredString(ctx.body, "tool");
  const cfg = getConfig();
  if (cfg.permissionMode === "graded") {
    // 分级模式：安装需要确认卡片（12.3/15.5）
    orchestrator.openCardPublic(orchestrator.projectDirs[0] ?? process.cwd(), "decision", "安装/修复环境组件", {
      decision: "install_tool",
      tool,
      options: ["安装", "暂不"],
    });
    ok(ctx.res, { started: false, detail: "分级询问模式：已在对话生成安装确认卡片" });
    return;
  }
  const h = startFix(tool);
  void h.promise.catch(() => {});
  ok(ctx.res, { started: true, installId: h.id });
});

route("POST", "/api/envcheck/cancel", (ctx) => {
  const installId = requiredString(ctx.body, "installId");
  const r = cancelInstall(installId);
  ok(ctx.res, { cancelled: r });
});

// 心跳
route("GET", "/api/heartbeat", (ctx) => {
  ok(ctx.res, { last: heartbeat.lastRecord() ?? null, dot: heartbeat.dot(), history: heartbeat.history() });
});

route("POST", "/api/heartbeat/run", async (ctx) => {
  const r = await heartbeat.runNow();
  ok(ctx.res, r);
});

// MCP 与 skills（12）
route("GET", "/api/mcp", async (ctx) => {
  const r = await listMcpServers();
  ok(ctx.res, r);
});

route("POST", "/api/mcp", async (ctx) => {
  try {
    const r = await addMcpServer({
      name: requiredString(ctx.body, "name"),
      command: requiredString(ctx.body, "command"),
      args: Array.isArray(ctx.body?.args) ? ctx.body.args.map(String) : [],
      env: ctx.body?.env && typeof ctx.body.env === "object" ? ctx.body.env : undefined,
      url: typeof ctx.body?.url === "string" ? ctx.body.url : undefined,
    });
    ok(ctx.res, r);
  } catch (e: any) {
    fail(ctx.res, 400, "BAD_REQUEST", e.message);
  }
});

route("POST", "/api/mcp/:id/toggle", async (ctx) => {
  const enabled = ctx.body?.enabled !== false;
  const r = await toggleMcpServer(ctx.params.id, enabled);
  if (!r.ok) fail(ctx.res, 500, "INTERNAL", r.detail);
  else ok(ctx.res, r);
});

route("DELETE", "/api/mcp/:id", async (ctx) => {
  const r = await removeMcpServer(ctx.params.id);
  if (!r.ok) fail(ctx.res, 500, "INTERNAL", r.detail);
  else ok(ctx.res, r);
});

route("POST", "/api/mcp/:id/test", async (ctx) => {
  const r = await testMcpServer(ctx.params.id);
  ok(ctx.res, r);
});

route("POST", "/api/skills/preview", async (ctx) => {
  const source = { dir: ctx.body?.dir, gitUrl: ctx.body?.gitUrl };
  const r = await previewSkillsImport(source);
  ok(ctx.res, r);
});

route("POST", "/api/skills/import", async (ctx) => {
  const source = { dir: ctx.body?.dir, gitUrl: ctx.body?.gitUrl, subPath: ctx.body?.subPath };
  const r = await importSkills(source);
  ok(ctx.res, r);
});

// 系统状态（13.5 右栏看门狗/循环状态；10.2 系统状态页）
route("GET", "/api/system", (ctx) => {
  const cfg = getConfig();
  const loops: Record<string, unknown> = {};
  for (const dir of orchestrator.projectDirs) {
    const rt = orchestrator.getRuntime(dir)!;
    for (const t of rt.store.list()) {
      if (Object.keys(t.loops).length > 0) loops[`${dir}::${t.id}`] = t.loops;
    }
  }
  ok(ctx.res, {
    watchdog: { usage: orchestrator.getWatchdogUsage(), limits: cfg.watchdog },
    loops,
    heartbeat: heartbeat.lastRecord() ?? null,
    versions: { node: process.version, platform: `${process.platform} ${os.release()}` },
    toolsDir: toolsDir(),
  });
});

// 诊断包（17：全部脱敏）
route("GET", "/api/diagnostics", (ctx) => {
  const cfg = getConfig();
  const payload = {
    exportedAt: new Date().toISOString(),
    version: "2.0.0",
    platform: `${process.platform} ${os.release()} node ${process.version}`,
    config: sanitizedConfig(),
    permissionRules: PolicyLedger.describe(),
    projects: loadProjects(),
    tasks: orchestrator.projectDirs.flatMap((d) => {
      const rt = orchestrator.getRuntime(d)!;
      return rt.store.list().map((t) => ({ project: d, ...JSON.parse(JSON.stringify(t)) }));
    }),
    loops: Object.fromEntries(
      orchestrator.projectDirs.flatMap((d) => {
        const rt = orchestrator.getRuntime(d)!;
        return rt.store.list().filter((t) => Object.keys(t.loops).length > 0).map((t) => [`${d}::${t.id}`, t.loops]);
      })
    ),
    watchdog: orchestrator.getWatchdogUsage(),
    heartbeat: heartbeat.history().slice(-20),
    logs: readRecentLogs(300),
    events: recentEvents().slice(-200),
  };
  // 深度脱敏：对序列化文本做密钥遮蔽后再回读（17）
  const text = redact(JSON.stringify(payload, null, 2));
  try {
    const cleaned = JSON.parse(text);
    ctx.res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="dispatch-diagnostics-${Date.now()}.json"`,
    });
    ctx.res.end(JSON.stringify(cleaned, null, 2));
  } catch {
    ctx.res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    ctx.res.end(text);
  }
});

// 截图证据
route("GET", "/api/screenshot", (ctx) => {
  const name = ctx.url.searchParams.get("name") ?? "";
  const file = path.join(dataDir(), "screenshots", path.basename(name));
  if (fs.existsSync(file)) {
    ctx.res.writeHead(200, { "Content-Type": "image/png" });
    fs.createReadStream(file).pipe(ctx.res);
  } else {
    ctx.res.writeHead(404);
    ctx.res.end();
  }
});

let lastEnvCheck: CheckResult[] = [];

// ───────────────────────── 请求分发 ─────────────────────────

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const pathname = url.pathname;
  const body = ["POST", "PUT", "DELETE"].includes(method) ? await readBody(req) : "";
  let parsedBody: any = {};
  if (body) {
    try {
      parsedBody = JSON.parse(body);
    } catch {
      fail(res, 400, "BAD_REQUEST", "请求体不是合法 JSON");
      return;
    }
  }
  // 令牌校验（16.2）：接口与事件流全部要求令牌
  if (tokenOf(req, url) !== ensureToken()) {
    fail(res, 401, "UNAUTHORIZED");
    return;
  }
  // 先按路径收集全部匹配路由，再按方法选中：同一路径的多个方法各自执行自己的处理器
  const samePath = ROUTES.map((r) => ({ r, params: matchRoute(r.pathPattern, pathname) })).filter((m) => m.params !== null);
  if (samePath.length === 0) {
    fail(res, 404, "NOT_FOUND", `${method} ${pathname}`);
    return;
  }
  const matched = samePath.find((m) => m.r.method === method);
  if (!matched) {
    // 14.2：路径存在但方法不对 → 405 并说明允许的方法（不得返回 404）
    const allows = [...new Set(samePath.map((m) => m.r.method))];
    const buf = JSON.stringify({ ok: false, code: "METHOD_NOT_ALLOWED", message: `${ERROR_CODES.METHOD_NOT_ALLOWED}（允许：${allows.join("、")}）` });
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: allows.join(", "), "Content-Length": Buffer.byteLength(buf) });
    res.end(buf);
    return;
  }
  try {
    await matched.r.handler({ req, res, url, body: parsedBody, params: matched.params! });
  } catch (e: any) {
    logError("api", `${method} ${pathname} 处理失败：${e?.message ?? e}`);
    if (!res.headersSent) fail(res, 500, "INTERNAL", String(e?.message ?? e));
    else res.end();
  }
}

export function createServer(): http.Server {
  ensureToken();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      // Host/Origin 校验（16.2）：对所有请求生效
      if (!originAllowed(req, url)) {
        fail(res, 403, "BAD_ORIGIN");
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      if (url.pathname.startsWith("/preview/")) {
        servePreview(res, url);
        return;
      }
      if (!serveStatic(req, res, url.pathname, url)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("未找到页面");
      }
    } catch (e: any) {
      logError("api", `${req.method} ${req.url} 处理失败：${e?.message ?? e}`);
      if (!res.headersSent) fail(res, 500, "INTERNAL", String(e?.message ?? e));
      else res.end();
    }
  });
}

/** 本进程内创建过的 HTTP 服务；测试结束后统一关闭，避免残留监听句柄。 */
const createdServers: http.Server[] = [];

function listen(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    createdServers.push(server);
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}

/** 关闭本进程所有 HTTP 服务（测试用）。 */
export function closeAllServers(): void {
  for (const s of createdServers.splice(0)) {
    try {
      s.closeAllConnections();
      s.closeIdleConnections();
      s.close();
    } catch {
      /* ignore */
    }
  }
}

/** 获取本次启动的访问令牌（start.sh 与测试用）。 */
export function accessToken(): string {
  return ensureToken();
}

/** 启动服务：只监听 127.0.0.1；端口被占用时自动顺延 3210→3211→3212。 */
export async function startServer(preferredPort?: number): Promise<number> {
  ensurePortableBrowserEnv();
  ensureToken();
  const cfg = getConfig();
  const host = cfg.host || "127.0.0.1";
  const wanted = preferredPort ?? cfg.port ?? 3210;
  const candidates = wanted === 3210 ? [3210, 3211, 3212] : [wanted, 3210, 3211, 3212];
  for (const port of candidates) {
    try {
      await listen(host, port);
      info("server", `调度中心已启动: http://${host}:${port} （仅监听本机；访问需令牌）`);
      fs.mkdirSync(dataDir(), { recursive: true });
      fs.writeFileSync(
        path.join(dataDir(), "runtime.json"),
        JSON.stringify({ port, host, token: ACCESS_TOKEN, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
        "utf8"
      );
      return port;
    } catch (e: any) {
      if (e.code === "EADDRINUSE") {
        warn("server", `端口 ${port} 被占用，尝试下一个端口…`);
        continue;
      }
      throw e;
    }
  }
  throw new Error("3210~3212 端口均被占用，请修改 config.json 的 port");
}

/** 载入配置、恢复全部已添加项目（M8 重启恢复）、启动服务；供入口脚本调用。 */
export async function bootServer(): Promise<number> {
  loadConfig();
  const projects = loadProjects();
  for (const p of projects) {
    try {
      orchestrator.addProject(p.path);
    } catch (e: any) {
      warn("server", `恢复项目失败（跳过）：${p.path} — ${e.message}`);
    }
  }
  return startServer();
}

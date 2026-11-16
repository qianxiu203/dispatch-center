/**
 * 本地后端服务（需求 3.1/3.4）：只监听 127.0.0.1，网页界面 + JSON API + SSE 事件流。
 * 无第三方框架（Node 内置 http），减少 Windows 环境下的依赖风险。
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
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
import { publish, subscribe, recentEvents, UiEvent } from "./events";
import { orchestrator } from "./orchestrator";
import { runEnvCheck, fixTool, ensurePortableBrowserEnv } from "./envcheck/check";
import { PolicyLedger } from "./policy/permissions";
import { appRoot, dataDir, safeJoin } from "./util/paths";
import { info, warn, error as logError } from "./logger";
import { TASK_STATUS_LABEL, projectDot, TaskStatus } from "./tasks/store";

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

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const buf = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(buf) });
  res.end(buf);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 启动一个 SSE 响应（头部 + 心跳），返回写入函数。 */
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
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    } catch {
      /* ignore */
    }
  };
}

/** 事件流端点：订阅总线并回放最近事件。 */
function eventsEndpoint(res: http.ServerResponse): void {
  const write = startSse(res);
  for (const e of recentEvents()) write(e);
  const unsub = subscribe((e) => write(e));
  res.on("close", unsub);
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.join(appRoot(), "public", rel);
  if (!file.startsWith(path.join(appRoot(), "public"))) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = `${req.method} ${url.pathname}`;
  const body = ["POST", "PUT"].includes(req.method ?? "") ? await readBody(req) : "";

  switch (route) {
    case "GET /api/health":
      json(res, 200, { ok: true, version: "1.0.0" });
      return true;

    case "GET /api/state": {
      const cfg = getConfig();
      const projects = loadProjects();
      const tasks = orchestrator.projectDir ? orchestrator.store.current.tasks : [];
      const cur = projects.find((p) => p.path === orchestrator.projectDir);
      json(res, 200, {
        config: sanitizedConfig(),
        permissionRules: PolicyLedger.describe(),
        projects: projects.map((p) => {
          const state = p.path === orchestrator.projectDir ? orchestrator.store.current : null;
          return {
            path: p.path,
            name: p.name,
            dot: state ? projectDot(state.tasks) : "idle",
            lastStatus: state && state.tasks.length ? TASK_STATUS_LABEL[state.tasks[state.tasks.length - 1].status] : "无任务",
          };
        }),
        currentProject: orchestrator.projectDir,
        task: tasks.length ? taskSnapshot(tasks[tasks.length - 1]) : null,
        cards: orchestrator.getOpenCards(),
        autoApprovals: orchestrator.ledger.records.slice(-200),
        running: orchestrator.isRunning,
      });
      return true;
    }

    case "POST /api/projects": {
      const { path: dir } = JSON.parse(body || "{}");
      if (!dir || typeof dir !== "string") return json(res, 400, { error: "需要提供项目目录 path" }), true;
      const abs = path.resolve(dir);
      try {
        fs.mkdirSync(abs, { recursive: true });
      } catch (e: any) {
        return json(res, 400, { error: `无法创建目录: ${e.message}` }), true;
      }
      const list = loadProjects();
      if (!list.some((p) => p.path === abs)) {
        const entry: ProjectEntry = { path: abs, name: path.basename(abs) };
        list.push(entry);
        saveProjects(list);
      }
      orchestrator.openProject(abs);
      orchestrator.recoverPendingTasks();
      info("api", `新增/打开项目: ${abs}`);
      json(res, 200, { ok: true, currentProject: abs });
      return true;
    }

    case "POST /api/projects/switch": {
      const { path: dir } = JSON.parse(body || "{}");
      const list = loadProjects();
      const entry = list.find((p) => p.path === path.resolve(dir ?? ""));
      if (!entry) return json(res, 404, { error: "项目不存在" }), true;
      orchestrator.openProject(entry.path);
      orchestrator.recoverPendingTasks();
      json(res, 200, { ok: true });
      return true;
    }

    case "POST /api/chat": {
      const { message } = JSON.parse(body || "{}");
      if (!message || typeof message !== "string") return json(res, 400, { error: "message 必填" }), true;
      if (!orchestrator.projectDir) return json(res, 400, { error: "请先添加项目" }), true;
      if (orchestrator.isRunning) return json(res, 409, { error: "任务执行中，请稍后再发消息" }), true;
      // 聊天回复以 SSE 流式返回（需求 4.1 / A2：分块到达，不等全部生成完）
      const write = startSse(res);
      orchestrator
        .handleUserMessage(message, (t) => write({ type: "chat-delta", text: t }))
        .then(() => {
          write({ type: "chat-done" });
          res.end();
        })
        .catch((e) => {
          write({ type: "chat-done", error: e.message });
          res.end();
        });
      return true;
    }

    case "POST /api/chat/confirm": {
      const { cardId } = JSON.parse(body || "{}");
      orchestrator
        .confirmRequirement(cardId)
        .catch((e) => publish({ type: "notice", level: "error", text: `启动任务失败: ${e.message}` }));
      json(res, 200, { ok: true });
      return true;
    }

    case "POST /api/chat/decide": {
      const { cardId, choice } = JSON.parse(body || "{}");
      orchestrator
        .decide(cardId, choice)
        .catch((e) => publish({ type: "notice", level: "error", text: `处理决策失败: ${e.message}` }));
      json(res, 200, { ok: true });
      return true;
    }

    case "GET /api/events":
      eventsEndpoint(res);
      return true;

    case "POST /api/config": {
      const patch = JSON.parse(body || "{}");
      saveConfig(patch);
      json(res, 200, { ok: true, config: sanitizedConfig() });
      return true;
    }

    case "POST /api/config/test": {
      const cfg = getConfig();
      const r = await testConnection(cfg.brain.baseUrl, cfg.brain.apiKey, cfg.brain.model);
      json(res, 200, r);
      return true;
    }

    case "GET /api/envcheck": {
      const results = await runEnvCheck();
      json(res, 200, { results });
      return true;
    }

    case "POST /api/envcheck/fix": {
      const { tool } = JSON.parse(body || "{}");
      if (!tool) return json(res, 400, { error: "需要提供 tool id" }), true;
      // 权限策略（需求 6.7）：YOLO 自动执行；分级模式需确认
      const cfg = getConfig();
      if (cfg.permissionMode === "graded") {
        orchestrator.openCardPublic("decision", "安装/修复环境组件", {
          decision: "install_tool",
          tool,
          options: ["安装", "暂不"],
        });
        json(res, 200, { ok: false, detail: "分级询问模式：已在对话框生成安装确认卡片，确认后自动安装。" });
        return true;
      }
      orchestrator.ledger.record("yolo", "allow", `一键修复环境: ${tool}`);
      const r = await fixTool(tool);
      json(res, 200, r);
      return true;
    }

    case "POST /api/rollback": {
      const r = await orchestrator.rollback();
      json(res, 200, r);
      return true;
    }

    case "GET /api/screenshot": {
      const name = url.searchParams.get("name") ?? "";
      const file = path.join(dataDir(), "screenshots", path.basename(name));
      if (fs.existsSync(file)) {
        res.writeHead(200, { "Content-Type": "image/png" });
        fs.createReadStream(file).pipe(res);
      } else {
        res.writeHead(404);
        res.end();
      }
      return true;
    }

    case "GET /api/logs": {
      // 近期通知（已脱敏），供界面诊断
      json(res, 200, { recent: recentEvents().filter((e) => e.type === "notice").slice(-100) });
      return true;
    }
  }
  return false;
}

function taskSnapshot(task: any) {
  return JSON.parse(
    JSON.stringify({
      ...task,
      statusLabel: TASK_STATUS_LABEL[task.status as TaskStatus] ?? task.status,
      criteriaWithDetail: Object.entries(task.criteriaStatus ?? {}).map(([id, v]: [string, any]) => ({
        id,
        ...v,
        text: task.criteria.find((c: any) => c.id === id)?.text ?? "",
      })),
    })
  );
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (url.pathname.startsWith("/api/")) {
        const handled = await handleApi(req, res, url);
        if (!handled) json(res, 404, { error: `未知接口: ${req.method} ${url.pathname}` });
        return;
      }
      if (!serveStatic(req, res, url.pathname)) {
        // 项目静态预览：调度中心代为托管项目目录里的静态页面，
        // 供网页类验收标准使用（url 形如 http://127.0.0.1:<port>/preview/index.html）
        if (url.pathname.startsWith("/preview/")) {
          if (!orchestrator.projectDir) {
            res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("未打开项目");
            return;
          }
          const rel = decodeURIComponent(url.pathname.slice("/preview/".length)) || "index.html";
          const file = safeJoin(orchestrator.projectDir, rel);
          if (fs.existsSync(file) && fs.statSync(file).isFile()) {
            const ext = path.extname(file).toLowerCase();
            res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
            fs.createReadStream(file).pipe(res);
            return;
          }
          // 目录形式：尝试 index.html
          const idx = safeJoin(orchestrator.projectDir, path.join(rel, "index.html"));
          if (fs.existsSync(idx)) {
            res.writeHead(200, { "Content-Type": MIME[".html"] });
            fs.createReadStream(idx).pipe(res);
            return;
          }
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("预览文件不存在");
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("未找到页面");
      }
    } catch (e: any) {
      logError("api", `${route0(req)} 处理失败: ${e.message}`);
      if (!res.headersSent) json(res, 500, { error: e.message });
      else res.end();
    }
  });
}

function route0(req: http.IncomingMessage): string {
  return `${req.method} ${req.url}`;
}

/** 启动服务：只监听 127.0.0.1；端口被占用时自动改用 3210（任务要求 7，盒子上 3000 常被占用）。 */
export async function startServer(preferredPort?: number): Promise<number> {
  ensurePortableBrowserEnv();
  const cfg = getConfig();
  const host = cfg.host || "127.0.0.1";
  const wanted = preferredPort ?? cfg.port ?? 3210;
  const candidates = wanted === 3210 ? [3210, 3211, 3212] : [wanted, 3210, 3211, 3212];
  for (const port of candidates) {
    try {
      await listen(host, port);
      info("server", `调度中心已启动: http://${host}:${port} （仅监听本机）`);
      fs.mkdirSync(dataDir(), { recursive: true });
      fs.writeFileSync(
        path.join(dataDir(), "runtime.json"),
        JSON.stringify({ port, host, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)
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

/** 本进程内创建过的 HTTP 服务；测试结束后统一关闭，避免残留监听句柄导致测试进程无法退出。 */
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

/** 载入配置并恢复上次的项目（供入口脚本调用）。 */
export function bootServer(): Promise<number> {
  loadConfig();
  const projects = loadProjects();
  if (projects.length > 0) {
    orchestrator.openProject(projects[0].path);
    orchestrator.recoverPendingTasks();
  }
  return startServer();
}

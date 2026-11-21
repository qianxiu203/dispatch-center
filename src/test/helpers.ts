/**
 * v2 测试公共工具（需求 18：一律「假工人 + 假大脑」，不消耗真实额度）。
 *
 * - startMockBrain：OpenAI 兼容 /chat/completions SSE 上游，按提示词路由脚本回复。
 * - FakeWorker：WorkerAdapter 桩（kind="codex"，注册后覆盖真实适配器），
 *   可编排事件序列、写文件、DISPATCH_BLOCKED、提问、硬拦截、启动失败。
 * - api：带令牌的 HTTP 客户端；startTestServer：随机端口 + 令牌。
 * - 每个测试文件独享临时数据目录（setDataDirForTest），互不覆盖。
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { setConfigForTest } from "../config";
import { setDataDirForTest } from "../util/paths";
import { startServer, closeAllServers, accessToken } from "../server";
import { injectWorker } from "../orchestrator";
import type { WorkerAdapter, WorkerEvent, WorkerRunOptions, WorkerRunResult } from "../worker/types";

// ───────────────────────── 临时目录与配置 ─────────────────────────

export function makeTempProject(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dispatch-v2-${tag}-`));
  return dir;
}

let testDataDir: string | null = null;
export function ensureTestDataDir(): string {
  if (!testDataDir) {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-v2-data-"));
    setDataDirForTest(testDataDir);
    process.on("exit", () => {
      try {
        fs.rmSync(testDataDir!, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
  }
  return testDataDir;
}

export function endTest(): void {
  closeAllServers();
}

// ───────────────────────── 假大脑 ─────────────────────────

export interface MockBrain {
  port: number;
  /** 每次请求的最后一条 user 消息（按到达顺序记录）。 */
  calls: string[];
  /** 设置路由：输入全部 messages，返回要流式发送的完整文本；返回数组则按块流式发送（每块间隔 400ms）。 */
  respondWith(fn: (lastUser: string, messages: { role: string; content: string }[]) => string | string[]): void;
  /** 让下一次请求返回 HTTP 错误（一次性）。 */
  failNext(status: number, body: string): void;
  close: () => void;
}

export type BrainReplyFn = (lastUser: string, messages: { role: string; content: string }[]) => string | string[];

export function startMockBrain(): Promise<MockBrain> {
  let handler: BrainReplyFn = () => '{"type":"chat","text":"（测试大脑未配置回复脚本）"}';
  const calls: string[] = [];
  let failNext: { status: number; body: string } | null = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const messages: { role: string; content: string }[] = body.messages ?? [];
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      calls.push(lastUser);
      if (failNext) {
        const f = failNext;
        failNext = null;
        res.writeHead(f.status, { "Content-Type": "application/json" });
        res.end(f.body);
        return;
      }
      const text = handler(lastUser, messages);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const chunks = Array.isArray(text) ? text : [text];
      let i = 0;
      const sendNext = () => {
        if (i >= chunks.length) {
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: chunks[i++] } }] })}\n\n`);
        setTimeout(sendNext, 400);
      };
      sendNext();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        calls,
        respondWith(fn) {
          handler = fn;
        },
        failNext(status, body) {
          failNext = { status, body };
        },
        close: () => server.close(),
      });
    });
  });
}

/** 构造 requirement 类型的假大脑回复。criteria 直接放草稿对象。 */
export function requirementJson(text: string, criteria: any[], requirement?: string): string {
  return JSON.stringify({ type: "requirement", text, requirement: requirement ?? text, criteria });
}

export function planJson(steps: { id?: string; title: string; instruction?: string }[]): string {
  return JSON.stringify({ type: "plan", text: "拆解完成", steps });
}

export function answerJson(answer: string, unsure = false): string {
  return JSON.stringify({ type: "answer", text: answer, answer, unsure });
}

export function intentJson(intent: string, text = "好的"): string {
  return JSON.stringify({ type: "intent", text, intent, confidence: 0.99 });
}

export function summaryJson(text: string): string {
  return JSON.stringify({ type: "summary", text });
}

export function memoryConsolidationJson(add: string[] = []): string {
  return JSON.stringify({ type: "memory_consolidation", text: "已整理", add, update: [], delete: [] });
}

/** 测试用默认标准：一个文件存在标准（验收走真实文件检查）。 */
export function fileCriterion(path = "index.html", id = "C1"): any {
  return { id, text: `存在 ${path}`, kind: "file_exists", path };
}

// ───────────────────────── 假工人 ─────────────────────────

export interface FakeAction {
  /** 派发事件（message/command/permission 等）。 */
  events?: WorkerEvent[];
  /** 完成前写入项目目录的文件（模拟工人改了文件）。 */
  writeFiles?: Record<string, string>;
  /** 完成前删除项目目录里的文件（模拟改动消失，供振荡场景）。 */
  deleteFiles?: string[];
  /** 模拟处理耗时（期间可被 stop() 打断）。 */
  delayMs?: number;
  /** WorkerRunResult 覆盖（默认 ok:true）。 */
  result?: Partial<WorkerRunResult>;
}

export class FakeWorker implements WorkerAdapter {
  readonly kind = "codex"; // 注册后覆盖真实 codex 适配器（orchestrator 用 cfg.worker.kind="codex" 取件）
  /** 每次调用的入参记录。 */
  calls: WorkerRunOptions[] = [];
  /** stop() 被调用的记录（暂停/取消语义）。 */
  stopped: number[] = [];
  private seq = 0;

  constructor(public behavior: (callIndex: number, opts: WorkerRunOptions) => FakeAction) {
    injectWorker(this);
  }

  run(opts: WorkerRunOptions): { stop: () => void; result: Promise<WorkerRunResult> } {
    const idx = this.seq++;
    this.calls.push(opts);
    let stopped = false;
    return {
      stop: () => {
        stopped = true;
        this.stopped.push(idx);
      },
      result: (async () => {
        const action = this.behavior(idx, opts);
        if (action.delayMs) {
          // 分段等待，期间可被 stop() 打断（暂停/取消语义）
          const deadline = Date.now() + action.delayMs;
          while (Date.now() < deadline && !stopped) await new Promise((r) => setTimeout(r, 50));
        }
        if (stopped) return { ok: false }; // 被停止：无 error 的失败 → 调度侧识别为 stopped
        for (const rel of action.deleteFiles ?? []) {
          fs.rmSync(path.join(opts.projectDir, rel), { force: true });
        }
        for (const [rel, content] of Object.entries(action.writeFiles ?? {})) {
          fs.mkdirSync(path.join(opts.projectDir, path.dirname(rel)), { recursive: true });
          fs.writeFileSync(path.join(opts.projectDir, rel), content, "utf8");
        }
        for (const e of action.events ?? []) {
          opts.onEvent(e);
          if (e.kind === "permission" && e.verdict === "block") {
            return { ok: false }; // 硬拦截事件：适配器层终止进程（与真实实现一致）
          }
        }
        return { ok: true, lastMessage: "", threadId: `fake-thread-${idx}`, ...action.result };
      })(),
    };
  }

  /** 便捷行为：什么都不做。 */
  static noop(): FakeWorker {
    return new FakeWorker(() => ({}));
  }

  /** 便捷行为：写一批文件然后完成。 */
  static writes(files: Record<string, string>): FakeWorker {
    return new FakeWorker(() => ({ writeFiles: files }));
  }
}

// ───────────────────────── 测试配置与服务 ─────────────────────────

/** 应用完整 v2 测试配置（假大脑地址 + 限额；worker.kind 固定 codex，由 FakeWorker 覆盖注册）。 */
export function applyTestConfig(brainPort: number, overrides: Partial<Parameters<typeof setConfigForTest>[0]> = {}): void {
  ensureTestDataDir();
  setConfigForTest({
    port: 3210,
    host: "127.0.0.1",
    brain: { baseUrl: `http://127.0.0.1:${brainPort}/v1`, apiKey: "test-key-not-real", model: "mock-model", maxContextTokens: 32768, compressThreshold: 0.7 },
    worker: { kind: "codex", executablePath: "", baseUrl: "", model: "", apiKey: "", dangerFullAccess: false, sandboxNetworkAccess: true },
    permissionMode: "yolo",
    limits: {
      maxFixAttempts: 3,
      maxStepsPerTask: 30,
      maxMinutesPerTask: 60,
      maxFixPerSignature: 3,
      maxTotalFixes: 6,
      maxWorkerQuestions: 15,
      maxCriteriaRegen: 2,
      maxHarnessRegen: 1,
    },
    watchdog: { maxTotalMinutes: 90, maxWorkerCalls: 40, maxSilenceMinutes: 10, maxBrainCalls: 200 },
    heartbeat: { intervalMinutes: 5 },
    acceptance: { commandTimeoutSeconds: 60 },
    env: { mirrorDownloadHost: "https://cdn.npmmirror.com/binaries/playwright" },
    ...overrides,
  });
}

export async function startTestServer(): Promise<{ port: number; token: string }> {
  ensureTestDataDir();
  const port = await startServer(30000 + Math.floor(Math.random() * 20000));
  return { port, token: accessToken() };
}

// ───────────────────────── HTTP 客户端 ─────────────────────────

export interface ApiResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  json: any;
}

export async function api(port: number, token: string, method: string, apiPath: string, body?: any, headers: Record<string, string> = {}): Promise<ApiResponse> {
  const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, {
    method,
    headers: { "Content-Type": "application/json", "x-dispatch-token": token, Origin: `http://127.0.0.1:${port}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), json };
}

/** 发起聊天并等待 chat-done（SSE 响应体整体读完）。返回解析出的事件数组。 */
export async function chat(port: number, token: string, project: string, message: string, requestId?: string): Promise<{ events: any[]; status: number }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-dispatch-token": token, Origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ project, message, requestId: requestId ?? `r-${Math.random().toString(36).slice(2)}` }),
  });
  const text = await res.text();
  const events = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice(5).trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { events, status: res.status };
}

/** 读取 SSE 事件流的前 count 个事件（供 V11 与 chat 流式测试）。 */
export async function readSse(port: number, token: string, apiPath: string, count: number, closeOnDone = true): Promise<{ events: any[]; ids: number[] }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: apiPath, headers: { "x-dispatch-token": token, Accept: "text/event-stream", Origin: `http://127.0.0.1:${port}` } },
      (res) => {
        let buf = "";
        const events: any[] = [];
        const ids: number[] = [];
        let finished = false; // resolve 后停止解析：数组引用已交给调用方，不能继续增长
        res.on("data", (c: Buffer) => {
          if (finished) return;
          buf += c.toString();
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const idLine = frame.split("\n").find((l) => l.startsWith("id:"));
            const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            try {
              const ev = JSON.parse(dataLine.slice(5).trim());
              events.push(ev);
              // 事件 id 既在 SSE id 行，也在 JSON 载荷里（两者一致）
              const id = idLine ? parseInt(idLine.slice(3).trim(), 10) : ev?.id;
              if (typeof id === "number" && Number.isFinite(id)) ids.push(id);
              if (events.length >= count) {
                finished = true;
                if (closeOnDone) res.destroy();
                resolve({ events, ids });
                return;
              }
            } catch {
              /* 忽略注释行 */
            }
          }
        });
        res.on("error", () => {
          if (events.length >= count) resolve({ events, ids });
          else reject(new Error("SSE 连接提前断开"));
        });
        req.on("error", reject);
      }
    );
  });
}

/** 等待条件成立（轮询）。 */
export async function waitFor(pred: () => boolean, timeoutMs = 15000, step = 100): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return pred();
}

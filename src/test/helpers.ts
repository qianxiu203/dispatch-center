/** 测试公共工具：临时项目目录、mock OpenAI 兼容上游、服务器启动。 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { setConfigForTest } from "../config";
import { setDataDirForTest } from "../util/paths";
import { startServer } from "../server";

/** 建立隔离的临时项目目录。 */
export function makeTempProject(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dispatch-test-${tag}-`));
  return dir;
}

export interface MockUpstreamScript {
  /** 每个元素是一段按顺序发送的 delta.content 文本；发送间可插入延迟。 */
  chunks: (string | { text: string; delayMs: number })[];
  /** 最终完整内容（用于校验）。 */
}

/** 启动一个 mock 的 OpenAI 兼容 /chat/completions SSE 上游。 */
export function startMockBrain(script: MockUpstreamScript): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    let i = 0;
    const sendNext = () => {
      if (i >= script.chunks.length) {
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      const item = script.chunks[i++];
      const text = typeof item === "string" ? item : item.text;
      const delay = typeof item === "string" ? 30 : item.delayMs;
      setTimeout(() => {
        res.write(
          `data: ${JSON.stringify({
            id: "mock",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: text } }],
          })}\n\n`
        );
        sendNext();
      }, delay);
    };
    sendNext();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

/** 启动被测服务（随机端口），返回实际端口。 */
export async function startTestServer(): Promise<number> {
  return startServer(30000 + Math.floor(Math.random() * 20000));
}

/** 测试进程独享的临时数据目录（避免并发测试互相覆盖真实 data/projects.json）。 */
let testDataDir: string | null = null;
function ensureTestDataDir(): string {
  if (!testDataDir) {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-test-data-"));
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

/** 测试专用配置：指向 mock 上游 + 临时 worker，避免依赖本机 config.json。 */
export function applyTestConfig(mockBrainPort: number): void {
  ensureTestDataDir();
  setConfigForTest({
    port: 3210,
    host: "127.0.0.1",
    brain: { baseUrl: `http://127.0.0.1:${mockBrainPort}/v1`, apiKey: "test-key-not-real", model: "mock-model" },
    worker: { kind: "codex", executablePath: "", baseUrl: "", model: "", apiKey: "" },
    permissionMode: "yolo",
    limits: { maxFixAttempts: 3, maxStepsPerTask: 30, maxMinutesPerTask: 60 },
    acceptance: { commandTimeoutSeconds: 60 },
  });
}

/**
 * 启动一个返回 plan JSON 的 mock 大脑并应用测试配置。
 * 供用桩工人验证主循环的测试使用（startTask 内部会调大脑拆解步骤）。
 */
export async function useMockPlanBrain(): Promise<{ close: () => void }> {
  const planJson = JSON.stringify({
    type: "plan",
    text: "好的，我来拆解步骤。",
    steps: [{ id: "S1", title: "执行需求", instruction: "在项目目录内按需求实现" }],
  });
  const mock = await startMockBrain({ chunks: [planJson] });
  applyTestConfig(mock.port);
  return mock;
}

/** 读取文件等待出现（轮询）。 */
export async function waitFor(pred: () => boolean, timeoutMs = 30000, step = 200): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return pred();
}

/** 启动一个故意带报错的页面：控制台 error + 未捕获异常 + 404 请求（A7 用）。 */
export function startMockBrokenPage(): Promise<{ port: number; close: () => void }> {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<h1>坏页面</h1>
<script>
  console.error("故意产生的控制台报错：依赖缺失");
  setTimeout(() => { throw new Error("故意的未捕获异常"); }, 200);
  fetch("/api/missing-endpoint").catch(() => {});
</script>
<img src="/missing.png">
</body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

/**
 * 大脑客户端：OpenAI 兼容接口（需求 3.5），必须流式（需求 4.1）。
 *
 * SSE 解析要点：上游返回 text/event-stream，形如
 *   data: {"choices":[{"delta":{"content":"片段"}}]}
 *   data: [DONE]
 * 只提取 choices[0].delta.content 的文本增量；绝不把原始协议文本原样转发（任务要求 4）。
 * 兼容 \r\n 换行、跨 TCP 分块的半行缓冲、一个 chunk 内多条事件。
 */
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";
import { redact, error as logError } from "../logger";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
  /** 每收到一段增量文本时回调。 */
  onDelta?: (text: string) => void;
}

/** 从一行 SSE 数据中提取 delta.content；返回 null 表示该行没有文本增量。 */
export function extractDeltaContent(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  let obj: any;
  try {
    obj = JSON.parse(payload);
  } catch {
    return null; // 非完整 JSON 的行丢弃，绝不透出原始协议文本
  }
  const delta = obj?.choices?.[0]?.delta;
  if (!delta) return null;
  const c = delta.content;
  return typeof c === "string" && c.length > 0 ? c : null;
}

/** 逐行解析 SSE 数据行，回调每个文本增量。 */
export class SseParser {
  private buf = "";

  /** 喂入一段原始文本（可能含半行），返回本次解析出的增量文本。 */
  push(chunk: string, onDelta: (t: string) => void): string {
    this.buf += chunk;
    // 统一处理 \r\n 与 \n，保留未结束的半行
    this.buf = this.buf.replace(/\r\n/g, "\n");
    let idx: number;
    let extracted = "";
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      const delta = extractDeltaContent(line);
      if (delta) {
        extracted += delta;
        onDelta(delta);
      }
    }
    return extracted;
  }
}

function requestOnce(
  url: URL,
  body: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
        },
      },
      (res) => resolve(res)
    );
    req.on("error", reject);
    // 空闲超时：连接建立后若 120 秒没有任何数据（含流式间隔），中断请求，
    // 防止上游挂死导致聊天/规划永久等待
    req.setTimeout(120000, () => req.destroy(new Error("大脑接口超过 120 秒无响应，已中断")));
    if (signal) {
      signal.addEventListener("abort", () => req.destroy(new Error("已取消")), { once: true });
    }
    req.write(body);
    req.end();
  });
}

/** 流式对话：把 delta.content 增量回调出去，最终返回完整文本。 */
export async function streamChat(opts: StreamOptions): Promise<string> {
  const url = new URL(opts.baseUrl.replace(/\/+$/, "") + "/chat/completions");
  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    stream: true,
    temperature: opts.temperature ?? 0.3,
  });

  const res = await requestOnce(url, body, opts.apiKey, opts.signal);
  if (res.statusCode !== 200) {
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const msg = redact(`大脑接口返回 ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8").slice(0, 500)}`);
    logError("llm", msg);
    throw new Error(msg);
  }

  const parser = new SseParser();
  let full = "";
  const onDelta = (t: string) => {
    full += t;
    opts.onDelta?.(t);
  };
  for await (const chunk of res) {
    if (opts.signal?.aborted) break;
    parser.push(chunk.toString("utf8"), onDelta);
  }
  return full;
}

/** 非流式一次调用（设置中心的「测试连接」用，模型只需吐少量文本）。 */
export async function testConnection(
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<{ ok: boolean; detail: string }> {
  const url = new URL(baseUrl.replace(/\/+$/, "") + "/chat/completions");
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: "回复两个字：正常" }],
    max_tokens: 16,
    stream: false,
  });
  try {
    const res = await requestOnce(url, body, apiKey);
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    if (res.statusCode !== 200) {
      return { ok: false, detail: redact(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`) };
    }
    const obj = JSON.parse(text);
    const content = obj?.choices?.[0]?.message?.content ?? "";
    return { ok: true, detail: `连接正常，模型回复: ${String(content).slice(0, 50)}` };
  } catch (e: any) {
    return { ok: false, detail: redact(String(e?.message ?? e)) };
  }
}

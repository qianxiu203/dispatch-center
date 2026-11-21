import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { dataDir } from "./util/paths";

/**
 * 事件总线 v2（需求 3/7.1/4.1-M7）：
 * - 每个事件带全局递增 id（前端断线重连时按 lastEventId 补发，需求 L9）。
 * - 因果链：publish 可携带触发它的（causalId, causalDepth）；系统事件触发的大脑自动回复
 *   产生的后续事件深度加 1（M7）。深度 > 3 的事件只记录、不触发任何动作（orchestrator 使用
 *   canTriggerAction 过滤）；心跳/看门狗/进度类事件列在 NEVER_WAKE 列表，任何情况下都不得唤醒大脑。
 * - 保留最近 MAX_HISTORY 条，新客户端连接时按 id 增量回放。
 */

let seq = 0;
try {
  // 事件序号不落盘也能正确工作：重启后从 0 重新递增，前端带 lastEventId 重连时
  // 只回放内存缓冲中 id 更大的事件；若缓冲里没有比它更新的事件（例如刚重启），
  // 前端会收到 marked 重置提示后全量拉一次 /api/state。
  const f = path.join(dataDir(), "events.seq");
  if (fs.existsSync(f)) seq = parseInt(fs.readFileSync(f, "utf8").trim(), 10) || 0;
} catch {
  /* 忽略读取失败 */
}

export const NEVER_WAKE_BRAIN = new Set([
  "heartbeat",
  "watchdog",
  "envcheck-progress",
  "loop-update",
  "worker-output",
  "worker-command",
  "acceptance",
  "task-update",
  "chat-delta",
  "chat-done",
  "session-update",
  "memory-update",
]);

export interface EventMeta {
  id: number;
  ts: string;
  causalId?: number | null;
  causalDepth?: number;
}

type BaseEvent =
  | { type: "chat-delta"; sessionId: string; text: string; msgId: string }
  | { type: "chat-done"; sessionId: string; error?: string }
  | { type: "card"; projectDir?: string; card: Card }
  | { type: "card-update"; projectDir?: string; card: Card }
  | { type: "task-update"; projectDir: string; task: unknown }
  | { type: "step-update"; projectDir: string; taskId: string; step: unknown }
  | { type: "worker-output"; projectDir: string; taskId: string; text: string }
  | { type: "worker-command"; projectDir: string; taskId: string; command: string; output?: string; exitCode?: number | null }
  | { type: "acceptance"; projectDir: string; taskId: string; report: unknown }
  | { type: "auto-approve"; projectDir: string; taskId: string; action: string; rule: string }
  | { type: "hard-block"; projectDir: string; taskId: string; action: string; rule: string }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string; taskId?: string }
  | { type: "envcheck"; results: unknown }
  | { type: "envcheck-progress"; installId: string; step: string; percent?: number; bytes?: number; speedBps?: number; log?: string; done?: boolean; ok?: boolean; error?: string }
  | { type: "heartbeat"; dot: "green" | "yellow" | "red"; summary: string; items?: unknown }
  | { type: "watchdog"; taskId: string | null; usage: unknown }
  | { type: "loop-update"; taskId: string; loops: unknown }
  | { type: "session-update"; projectDir: string; sessionId: string; title?: string; archived?: boolean }
  | { type: "memory-update"; scope: "project" | "global" };

export type UiEvent = BaseEvent & EventMeta;

export interface Card {
  id: string;
  kind: "requirement" | "decision";
  title: string;
  payload: any;
  status: "open" | "confirmed" | "dismissed" | "answered";
  createdAt: string;
  taskId?: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(200);

const history: UiEvent[] = [];
const MAX_HISTORY = 800;

let flushTimer: NodeJS.Timeout | null = null;
function persistSeq(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      fs.mkdirSync(dataDir(), { recursive: true });
      fs.writeFileSync(path.join(dataDir(), "events.seq"), String(seq), "utf8");
    } catch {
      /* 忽略 */
    }
  }, 2000);
}

/**
 * 发布事件。cause 传入触发本事件的上游事件（其 id 与深度）。
 * 心跳、看门狗、进度类事件永远不能作为唤醒大脑的原因（NEVER_WAKE_BRAIN，需求 M7）。
 */
export function publish(event: BaseEvent, cause?: { causalId?: number | null; causalDepth?: number }): UiEvent {
  seq += 1;
  const full: UiEvent = {
    ...event,
    id: seq,
    ts: new Date().toISOString(),
    causalId: cause?.causalId ?? null,
    // 因果深度：系统事件触发的自动动作，深度在上游基础上 +1（M7）
    causalDepth: cause ? (cause.causalDepth ?? 0) + 1 : 0,
  } as UiEvent;
  history.push(full);
  if (history.length > MAX_HISTORY) history.shift();
  persistSeq();
  bus.emit("event", full);
  return full;
}

/** M7：深度大于 3 的事件只记录、不触发动作；心跳/看门狗/进度类事件永远不唤醒大脑。 */
export function canTriggerAction(e: UiEvent): boolean {
  if ((e.causalDepth ?? 0) > 3) return false;
  if (NEVER_WAKE_BRAIN.has(e.type)) return false;
  return true;
}

export function subscribe(fn: (e: UiEvent) => void): () => void {
  bus.on("event", fn);
  return () => bus.off("event", fn);
}

/** 取 id 大于 afterId 的事件（断线补发，需求 L9）。 */
export function eventsSince(afterId: number): UiEvent[] {
  return history.filter((e) => e.id > afterId);
}

export function recentEvents(): UiEvent[] {
  return [...history];
}

export function currentEventId(): number {
  return seq;
}

let cardSeq = 0;
export function newCardId(): string {
  cardSeq += 1;
  return `card-${Date.now()}-${cardSeq}`;
}

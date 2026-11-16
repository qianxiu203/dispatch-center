import { EventEmitter } from "node:events";

/**
 * 事件总线：后端各模块发布事件，经 /api/events 的 SSE 推给前端右栏。
 * 保留最近 600 条，新客户端连接时先回放。
 */
export type UiEvent =
  | { type: "chat-delta"; text: string }
  | { type: "chat-done"; error?: string }
  | { type: "card"; card: Card }
  | { type: "card-update"; card: Card }
  | { type: "task-update"; projectDir: string; task: unknown }
  | { type: "step-update"; projectDir: string; taskId: string; step: unknown }
  | { type: "worker-output"; projectDir: string; taskId: string; text: string }
  | { type: "worker-command"; projectDir: string; taskId: string; command: string; output?: string; exitCode?: number | null }
  | { type: "acceptance"; projectDir: string; taskId: string; report: unknown }
  | { type: "auto-approve"; projectDir: string; taskId: string; action: string; rule: string }
  | { type: "hard-block"; projectDir: string; taskId: string; action: string; rule: string }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "envcheck"; results: unknown };

export interface Card {
  id: string;
  kind: "requirement" | "decision";
  title: string;
  payload: any;
  status: "open" | "confirmed" | "dismissed" | "answered";
  createdAt: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(100);

const history: UiEvent[] = [];
const MAX_HISTORY = 600;

export function publish(event: UiEvent): void {
  history.push(event);
  if (history.length > MAX_HISTORY) history.shift();
  bus.emit("event", event);
}

export function subscribe(fn: (e: UiEvent) => void): () => void {
  bus.on("event", fn);
  return () => bus.off("event", fn);
}

export function recentEvents(): UiEvent[] {
  return [...history];
}

let cardSeq = 0;
export function newCardId(): string {
  cardSeq += 1;
  return `card-${Date.now()}-${cardSeq}`;
}

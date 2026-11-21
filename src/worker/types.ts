/**
 * 工人适配器统一接口（需求 6.3）：启动、发送消息、接收流式进度、响应权限请求、停止。
 * 新增工人只需新增一个适配器文件并注册（一期约定沿用）。
 */

export type WorkerEventKind =
  | "thread"
  | "message"
  | "reasoning"
  | "command"
  | "file"
  | "error"
  | "fatal"
  | "done"
  | "permission";

export interface WorkerEvent {
  kind: WorkerEventKind;
  text?: string;
  threadId?: string;
  command?: string;
  output?: string;
  exitCode?: number | null;
  verdict?: "block" | "ask";
  ruleId?: string;
  ruleLabel?: string;
}

export interface WorkerRunOptions {
  projectDir: string;
  prompt: string;
  mode: "yolo" | "graded";
  resumeThreadId?: string;
  onEvent: (e: WorkerEvent) => void;
}

export interface WorkerRunResult {
  ok: boolean;
  lastMessage?: string;
  threadId?: string;
  error?: string;
  /** 工人用约定格式（DISPATCH_BLOCKED: 原因）回报「问题在调度侧」（需求 8.3）。 */
  dispatchBlocked?: string;
}

/** 工人适配器统一接口（需求 6.3）：新增工人只需新增一个适配器文件并注册。 */
export interface WorkerAdapter {
  readonly kind: string;
  /** 启动一次工人调用；返回停止函数（暂停语义：停 10s → 结束进程树）与结果 Promise。 */
  run(opts: WorkerRunOptions): { stop: () => void; result: Promise<WorkerRunResult> };
}

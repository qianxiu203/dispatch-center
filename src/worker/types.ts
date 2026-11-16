/**
 * 工人适配器统一接口（需求 6.3）：
 * 启动、发送消息、接收流式进度、响应权限请求、停止。
 * 第一期只实现 codex 适配器；新增工人只需新增一个实现本接口的文件。
 */

export type WorkerEventKind =
  | "thread" // 会话标识（可用于 resume 续聊）
  | "message" // 工人对用户可见的说明文本
  | "reasoning" // 工人的思考过程（折叠展示）
  | "command" // 工人执行的命令及其输出
  | "file" // 文件变更
  | "error" // 非致命错误事件
  | "fatal" // 致命失败（本次运行失败）
  | "permission" // 权限相关：被拦截 / 需要询问（分级模式）
  | "done"; // 本次运行结束

export interface WorkerEvent {
  kind: WorkerEventKind;
  text?: string;
  command?: string;
  output?: string;
  exitCode?: number | null;
  threadId?: string;
  /** policy 模块对命令的裁决（permission 事件时提供）。 */
  verdict?: "block" | "ask";
  ruleId?: string;
  ruleLabel?: string;
}

export interface WorkerRunOptions {
  projectDir: string;
  prompt: string;
  mode: "yolo" | "graded";
  onEvent: (e: WorkerEvent) => void;
  /** 续聊：传上次运行的 threadId 时工人会继续同一会话。 */
  resumeThreadId?: string;
}

export interface WorkerRunResult {
  ok: boolean;
  lastMessage: string;
  threadId?: string;
  error?: string;
  /** 运行期间被硬拦截的命令（由适配器监控事件流得出）。 */
  blocked?: string[];
}

export interface WorkerAdapter {
  readonly kind: string;
  /** 启动并运行一次任务；返回句柄，可等待结果或中途停止。 */
  run(opts: WorkerRunOptions): {
    stop: () => void;
    result: Promise<WorkerRunResult>;
  };
}

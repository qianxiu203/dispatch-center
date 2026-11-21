import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { projectTasksDir } from "../util/paths";
import { warn, info } from "../logger";

/**
 * 任务状态机与落盘 v2（需求 5.5/6.1/6.2）：
 * - 状态：queued 待办、running 执行中、verifying 验收中、fixing 修复中、waiting_user 等待使用者、
 *   paused 已暂停、passed 通过、failed 失败、cancelled 已取消；passed/failed/cancelled 为终态。
 * - 每个任务一个 JSON 文件：<项目>/.dispatch/tasks/<taskId>.json（需求 5.1）。
 * - 只有 Orchestrator 能写任务文件（单写者，需求 7.3）；本 store 只提供落盘与迁移校验。
 * - 原子写（先临时文件再改名）；读到损坏 JSON 时保留 .bak 并提示，不覆盖、不崩溃（需求 5.2）。
 * - 快照：任务开始前 git 快照引用存 snapshotRef，可按任务回滚（需求 6.3）。
 */

export const SCHEMA_VERSION = 2;

export type TaskStatus =
  | "queued" // 待办
  | "running" // 执行中
  | "verifying" // 验收中
  | "fixing" // 修复中
  | "waiting_user" // 等待使用者
  | "paused" // 已暂停
  | "passed" // 通过（终态）
  | "failed" // 失败（终态）
  | "cancelled"; // 已取消（终态）

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "待办",
  running: "执行中",
  verifying: "验收中",
  fixing: "修复中",
  waiting_user: "等待我决定",
  paused: "已暂停",
  passed: "已通过",
  failed: "已失败",
  cancelled: "已取消",
};

/** 占用执行槽的状态（需求 6.2：paused 与 waiting_user 不占槽）。 */
export const SLOT_STATUSES: TaskStatus[] = ["running", "verifying", "fixing"];

/** 状态合法迁移表（需求 6.1）。其他一律拒绝并记录日志。 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["verifying", "waiting_user", "paused", "cancelled"],
  verifying: ["passed", "fixing", "waiting_user", "cancelled"],
  fixing: ["verifying", "paused", "cancelled"],
  waiting_user: ["running", "verifying", "cancelled"],
  paused: ["queued", "cancelled"],
  passed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** 项目卡片状态点（需求 13.2：空闲、运行中、等待我、已暂停、出错）。 */
export function projectDot(tasks: Task[]): "active" | "waiting" | "paused" | "error" | "idle" {
  const occupied = tasks.filter((t) => SLOT_STATUSES.includes(t.status));
  if (occupied.length > 0) return "active";
  if (tasks.some((t) => t.status === "waiting_user")) return "waiting";
  if (tasks.some((t) => t.status === "paused")) return "paused";
  if (tasks.some((t) => t.status === "failed")) return "error";
  return "idle";
}

export type CriterionKind = "web_console_clean" | "web_url" | "file_exists" | "command_exit_0";

export interface Criterion {
  id: string;
  text: string;
  kind: CriterionKind;
  url?: string;
  path?: string;
  command?: string;
}

export interface Step {
  id: string;
  title: string;
  instruction: string;
  status: "todo" | "in_progress" | "passed" | "failed";
  detail?: string;
}

/** 循环预算记录（LoopGuard 写入，需求 4.1-M1 落盘到任务文件 loops 字段）。 */
export interface LoopRecord {
  loopId: string;
  kind: string;
  iteration: number;
  maxIterations: number;
  noProgressCount: number;
  maxNoProgress: number;
  signatures: string[]; // 最近 8 个签名（M3）
  lastSignature?: string;
  lastNoProgressReason?: string;
  startedAt: string;
  stopped?: boolean;
  stopReason?: string;
  permitLog: { ts: string; allowed: boolean; reason?: string }[];
}

/** 修复尝试记录（需求 5.5：序号、签名、改动文件列表、起止时间）。 */
export interface FixAttempt {
  seq: number;
  signature: string;
  changedFiles: string[];
  startedAt: string;
  endedAt?: string;
  summary?: string;
}

export interface Task {
  schemaVersion: number;
  id: string;
  projectId: string;
  title: string;
  requirement: string;
  criteria: Criterion[];
  criteriaStatus: Record<string, { status: "pending" | "passed" | "failed"; detail?: string; evidence?: string }>;
  status: TaskStatus;
  statusHistory: { status: TaskStatus; ts: string; reason?: string }[];
  loops: Record<string, LoopRecord>;
  recoverCount: number;
  fixAttempts: FixAttempt[];
  workerSessionRef?: string;
  snapshotRef?: string;
  pausedReason?: string;
  /** M8：最近一次自动恢复的时刻（ISO），用于判断「恢复后 60 秒内再次异常退出」。 */
  lastRecoverAt?: string;
  steps: Step[];
  currentStepIndex: number;
  counters: { workerCalls: number; brainCalls: number; lastActivityAt: string; lastWorkerOutputAt: string };
  workerQuestionCount: number;
  createdAt: string;
  updatedAt: string;
}

function now(): string {
  return new Date().toISOString();
}

export interface ProjectTaskIndex {
  schemaVersion: number;
  projectDir: string;
  updatedAt: string;
  taskOrder: string[]; // 展示与队列顺序（恢复的暂停任务放队首）
}

/**
 * 项目任务存储：一个任务一个文件，index.json 只保存顺序。
 * 读损坏文件时保留 .bak（需求 5.2）。
 */
export class TaskStore {
  private projectDir = "";
  private tasks = new Map<string, Task>();
  private order: string[] = [];
  private indexFile = "";
  private dirtyOrder = false;

  /** 绑定项目目录并从 .dispatch/tasks 载入全部任务文件。 */
  load(projectDir: string): { tasks: Task[]; order: string[] } {
    this.projectDir = projectDir;
    this.tasks = new Map();
    this.order = [];
    this.indexFile = path.join(projectTasksDir(projectDir), "index.json");
    const dir = projectTasksDir(projectDir);
    fs.mkdirSync(dir, { recursive: true });
    // 读取顺序索引
    let savedOrder: string[] = [];
    try {
      const idx = JSON.parse(fs.readFileSync(this.indexFile, "utf8")) as ProjectTaskIndex;
      savedOrder = idx.taskOrder ?? [];
    } catch {
      /* 没有索引则按文件名排序 */
    }
    // 读取任务文件
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
    for (const f of files) {
      const file = path.join(dir, f);
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      try {
        const t = JSON.parse(raw) as Task;
        if (t && t.id) this.tasks.set(t.id, t);
      } catch (e: any) {
        // 损坏 JSON：保留 .bak、提示使用者，不得覆盖（需求 5.2）
        const bak = file + ".bak";
        try {
          fs.copyFileSync(file, bak);
          warn("store", `任务文件损坏已备份为 ${path.basename(bak)}，未覆盖: ${e.message}`);
        } catch {
          warn("store", `任务文件损坏且备份失败: ${file}`);
        }
      }
    }
    // 恢复顺序：索引优先，剩余按 id 排序
    const seen = new Set<string>();
    for (const id of savedOrder) {
      if (this.tasks.has(id) && !seen.has(id)) {
        this.order.push(id);
        seen.add(id);
      }
    }
    for (const id of [...this.tasks.keys()].sort()) {
      if (!seen.has(id)) this.order.push(id);
    }
    this.saveIndex();
    return { tasks: this.list(), order: [...this.order] };
  }

  list(): Task[] {
    return this.order.map((id) => this.tasks.get(id)!).filter(Boolean);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  get count(): number {
    return this.tasks.size;
  }

  /** 创建任务（需求 5.5 字段）。 */
  create(params: { projectId: string; title: string; requirement: string; criteria: Criterion[]; steps: Step[] }): Task {
    const id = `T${this.tasks.size + 1}-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
    const task: Task = {
      schemaVersion: SCHEMA_VERSION,
      id,
      projectId: params.projectId,
      title: params.title.slice(0, 80) || "新任务",
      requirement: params.requirement,
      criteria: params.criteria,
      criteriaStatus: {},
      status: "queued",
      statusHistory: [{ status: "queued", ts: now(), reason: "创建任务" }],
      loops: {},
      recoverCount: 0,
      fixAttempts: [],
      steps: params.steps,
      currentStepIndex: 0,
      counters: { workerCalls: 0, brainCalls: 0, lastActivityAt: now(), lastWorkerOutputAt: now() },
      workerQuestionCount: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    for (const c of params.criteria) task.criteriaStatus[c.id] = { status: "pending" };
    this.tasks.set(id, task);
    this.order.push(id);
    this.saveTask(task);
    this.saveIndex();
    info("store", `创建任务 ${id}「${task.title}」标准 ${params.criteria.length} 条`);
    return task;
  }

  fileOf(taskId: string): string {
    return path.join(projectTasksDir(this.projectDir), `${taskId}.json`);
  }

  /** 原子落盘单个任务文件。 */
  saveTask(task: Task): void {
    task.updatedAt = now();
    const file = this.fileOf(task.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2), "utf8");
    fs.renameSync(tmp, file);
  }

  private saveIndex(): void {
    const idx: ProjectTaskIndex = {
      schemaVersion: SCHEMA_VERSION,
      projectDir: this.projectDir,
      updatedAt: now(),
      taskOrder: [...this.order],
    };
    try {
      const tmp = this.indexFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), "utf8");
      fs.renameSync(tmp, this.indexFile);
    } catch {
      /* 索引写失败不阻断（列表仍按文件扫描恢复） */
    }
  }

  /** 移除任务（软删除由调用方把文件挪进 trash；这里只清内存与索引）。 */
  forget(taskId: string): void {
    this.tasks.delete(taskId);
    this.order = this.order.filter((x) => x !== taskId);
    this.saveIndex();
  }

  /** 恢复暂停任务 = 重新入队并放队首（需求 6.2）。 */
  requeueFront(taskId: string): void {
    this.order = [taskId, ...this.order.filter((x) => x !== taskId)];
    this.saveIndex();
  }

  /** 状态迁移（带迁移表校验与历史记录）；同状态视为幂等空操作。 */
  setStatus(task: Task, to: TaskStatus, reason?: string): void {
    if (task.status === to) return;
    if (!canTransition(task.status, to)) {
      throw new Error(`非法状态迁移 ${task.status} → ${to}（任务 ${task.id}）`);
    }
    task.status = to;
    task.statusHistory.push({ status: to, ts: now(), reason });
    this.saveTask(task);
  }

  /** 恢复/迁移旧数据场景：绕过迁移表（如把已不存在于迁移表的历史状态归位）。 */
  forceStatus(task: Task, to: TaskStatus, reason?: string): void {
    task.status = to;
    task.statusHistory.push({ status: to, ts: now(), reason: reason ?? "强制迁移" });
    this.saveTask(task);
  }
}

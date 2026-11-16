/**
 * 任务状态机与状态落盘（需求 6.2）。
 * 状态至少包含：待办、进行中、等待使用者、验收中、修复中、通过、失败、已暂停。
 * 状态写入 <项目目录>/.dispatch/state.json，程序重启后从该文件恢复，不依赖对话记忆。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { projectStateFile } from "../util/paths";
import { warn } from "../logger";

export type TaskStatus =
  | "todo" // 待办
  | "in_progress" // 进行中
  | "waiting_user" // 等待使用者
  | "accepting" // 验收中
  | "fixing" // 修复中
  | "passed" // 通过
  | "failed" // 失败
  | "paused"; // 已暂停

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "待办",
  in_progress: "进行中",
  waiting_user: "等待我决定",
  accepting: "验收中",
  fixing: "修复中",
  passed: "已完成",
  failed: "出错",
  paused: "已暂停",
};

/** 项目列表上的状态点（需求 5.1）：进行中 / 等待我决定 / 已完成 / 出错。 */
export function projectDot(tasks: Task[]): "active" | "waiting" | "done" | "error" | "idle" {
  if (tasks.length === 0) return "idle";
  const last = tasks[tasks.length - 1];
  switch (last.status) {
    case "in_progress":
    case "accepting":
    case "fixing":
    case "todo":
      return "active";
    case "waiting_user":
    case "paused":
      return "waiting";
    case "passed":
      return "done";
    case "failed":
      return "error";
  }
}

export type StepStatus = "todo" | "in_progress" | "passed" | "failed";

export interface Criterion {
  id: string; // C1、C2…
  text: string;
  kind: "web_console_clean" | "web_url" | "file_exists" | "command_exit_0";
  url?: string; // kind 为 web_* 时必填
  path?: string; // kind 为 file_exists 时：项目内相对路径
  command?: string; // kind 为 command_exit_0 时：在项目目录执行的命令
}

export interface Step {
  id: string; // S1、S2…
  title: string;
  instruction: string;
  status: StepStatus;
  detail?: string;
}

export interface Task {
  id: string;
  title: string;
  requirement: string;
  criteria: Criterion[];
  criteriaStatus: Record<string, { status: "pending" | "passed" | "failed"; detail?: string; screenshot?: string }>;
  status: TaskStatus;
  steps: Step[];
  currentStepIndex: number;
  fixAttempts: Record<string, number>; // 错误签名 -> 已修复次数
  conclusion?: string;
  threadId?: string; // 工人（codex）会话 id，用于修复循环续聊与重启后延续
  createdAt: string;
  updatedAt: string;
}

export interface ProjectState {
  version: 1;
  projectDir: string;
  updatedAt: string;
  tasks: Task[];
}

/** 状态合法迁移表：防止乱转。 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress", "failed", "paused"],
  in_progress: ["accepting", "waiting_user", "paused", "failed"],
  waiting_user: ["in_progress", "failed", "paused"],
  accepting: ["fixing", "passed", "failed", "in_progress"],
  fixing: ["accepting", "waiting_user", "paused", "failed", "in_progress"],
  passed: [],
  failed: ["in_progress", "todo"],
  paused: ["in_progress", "waiting_user", "failed"],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export class TaskStore {
  private state: ProjectState | null = null;
  private file = "";

  /** 绑定到某个项目目录并加载已有状态文件。 */
  load(projectDir: string): ProjectState {
    this.file = projectStateFile(projectDir);
    let state: ProjectState = { version: 1, projectDir, updatedAt: now(), tasks: [] };
    if (fs.existsSync(this.file)) {
      try {
        state = JSON.parse(fs.readFileSync(this.file, "utf8"));
      } catch (e: any) {
        warn("store", `状态文件损坏，重新开始: ${e.message}`);
      }
    }
    this.state = state;
    return state;
  }

  get current(): ProjectState {
    if (!this.state) throw new Error("TaskStore 未绑定项目目录");
    return this.state;
  }

  get boundFile(): string {
    return this.file;
  }

  /** 原子落盘：先写临时文件再改名，避免写一半损坏。 */
  save(): void {
    if (!this.state) return;
    this.state.updatedAt = now();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  createTask(title: string, requirement: string, criteria: Criterion[]): Task {
    const task: Task = {
      id: `T${this.current.tasks.length + 1}-${Date.now().toString(36)}`,
      title,
      requirement,
      criteria,
      criteriaStatus: {},
      status: "todo",
      steps: [],
      currentStepIndex: 0,
      fixAttempts: {},
      createdAt: now(),
      updatedAt: now(),
    };
    for (const c of criteria) task.criteriaStatus[c.id] = { status: "pending" };
    this.current.tasks.push(task);
    this.save();
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.current.tasks.find((t) => t.id === id);
  }

  lastTask(): Task | undefined {
    const ts = this.current.tasks;
    return ts.length ? ts[ts.length - 1] : undefined;
  }

  /** 状态迁移（带合法性检查）；同状态重复设置视为幂等空操作。 */
  setStatus(task: Task, to: TaskStatus): void {
    if (task.status === to) return;
    if (!canTransition(task.status, to)) {
      throw new Error(`非法状态迁移 ${task.status} -> ${to}（任务 ${task.id}）`);
    }
    task.status = to;
    task.updatedAt = now();
    this.save();
  }

  /** 恢复场景：重启后把进行中的任务原样落回（用于 A8），绕过迁移表。 */
  forceStatus(task: Task, to: TaskStatus): void {
    task.status = to;
    task.updatedAt = now();
    this.save();
  }

  setCriteria(task: Task, id: string, r: { status: "passed" | "failed"; detail?: string; screenshot?: string }): void {
    task.criteriaStatus[id] = { status: r.status, detail: r.detail, screenshot: r.screenshot };
    task.updatedAt = now();
    this.save();
  }

  setSteps(task: Task, steps: Step[]): void {
    task.steps = steps;
    task.currentStepIndex = 0;
    task.updatedAt = now();
    this.save();
  }

  updateStep(task: Task, stepId: string, patch: Partial<Step>): void {
    const s = task.steps.find((x) => x.id === stepId);
    if (!s) return;
    Object.assign(s, patch);
    task.updatedAt = now();
    this.save();
  }

  recordFixAttempt(task: Task, errorKey: string): number {
    task.fixAttempts[errorKey] = (task.fixAttempts[errorKey] ?? 0) + 1;
    task.updatedAt = now();
    this.save();
    return task.fixAttempts[errorKey];
  }

  setConclusion(task: Task, conclusion: string): void {
    task.conclusion = conclusion;
    task.updatedAt = now();
    this.save();
  }
}

function now(): string {
  return new Date().toISOString();
}

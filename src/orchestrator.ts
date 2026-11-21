/**
 * 编排器 v2：调度中心主流程（需求 6/7/8，防循环 M1–M10 与 L1–L13 在此落地）。
 *
 * 主流程（7.1 解耦）：
 *   使用者消息 →（空闲）大脑澄清/生成需求与验收标准 → L2 校验(≤2 次重生成) → 需求确认卡片
 *   → 使用者确认 → 创建任务(queued) → 大脑拆解步骤 → git 快照(6.3) → 入队
 *   →（7.1 异步）队列推进 L12：每项目执行槽=1，原子取件 queued→running
 *   → 逐步骤驱动工人 → 全部步骤完成 → 验收 verifying
 *   → 8.1 分流：全过→passed；harnessErrors→L3(不派工人)；problems→L1 修复循环；
 *     两者皆空但失败→内部错误暂停(V5)
 *   → 修复循环带 LoopGuard 预算(M1)、签名(M2)、振荡检测(M3)、精确次数(M4)、
 *     停止去向=M5 暂停+决策卡片；修复前快照对比 changedFiles(8.4)，空改动=无进展
 *   → 任务终态(passed/cancelled)触发 1 次记忆整理(L13/9.5)
 *
 * 任务执行中使用者消息 → 意图分类(7.2，schema 约束) → 查询进度/新需求/控制/回答/闲聊。
 * 工人提问 → L4 大脑代答(≤15，重复升级)；DISPATCH_BLOCKED 回报 → 调度侧缺陷候选不计次数(8.3/V14)；
 * 硬拦截 → L5（第 1 次拒绝并回复，第 2 次暂停）；工人启动失败 → L6 重试(≤2)。
 * 重启恢复 → M8（recoverCount 落盘，2 次后不再自动恢复）。
 * 命令一律经 Orchestrator（7.3 单写者），带 requestId 去重(M10)。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  TaskStore,
  Task,
  Criterion,
  Step,
  TaskStatus,
  SLOT_STATUSES,
  TASK_STATUS_LABEL,
  LoopRecord,
} from "./tasks/store";
import { getAdapter, registerAdapter, WorkerAdapter } from "./worker/codex";
import { WorkerEvent } from "./worker/types";
import { runAcceptance, runInProject, AcceptanceReport } from "./acceptance/runner";
import {
  callBrain,
  parseBrainReply,
  BrainReply,
  BRAIN_SYSTEM_PROMPT,
  INTENT_SYSTEM_PROMPT,
  workerQuestionPrompt,
  memoryConsolidationPrompt,
  compactionPrompt,
  criteriaRegenPrompt,
  BrainTurn,
  extractTextProgressive,
} from "./brain/brain";
import { validateCriteria, normalizeCriteria } from "./brain/criteria";
import { Card, publish, newCardId } from "./events";
import { LoopGuard } from "./loop/loopguard";
import { signatureOf, signatureOfProblems, EMPTY_SIGNATURE, normalizeErrorText } from "./loop/signature";
import { getConfig, loadProjects, saveProjects, ProjectEntry } from "./config";
import { PolicyLedger } from "./policy/permissions";
import { info, warn } from "./logger";
import { projectIdOf, projectTrashDir, safeJoin } from "./util/paths";
import { SessionStore, ChatLine } from "./session/store";
import { memory } from "./memory/memory";
import { heartbeat, HeartbeatRecord } from "./heartbeat";
import type { WatchdogTaskUsage, WatchdogTrigger } from "./watchdog";

/** 工人向使用者提问的约定前缀（写在工人提示词里；最终回复最后单独一行 QUESTION: ...）。 */
export const WORKER_QUESTION_PREFIX = "QUESTION:";

/** 测试可通过 registerAdapter 注入桩工人；生产用 codex。 */
export function injectWorker(adapter: WorkerAdapter): void {
  registerAdapter(adapter);
}

// ───────────────────────── 项目运行时 ─────────────────────────

/** 每个项目的运行时状态：任务存储、会话、卡片与内存态运行信息。 */
export class ProjectRuntime {
  readonly entry: ProjectEntry;
  readonly projectDir: string;
  store = new TaskStore();
  sessions = new SessionStore();
  ledger = new PolicyLedger(); // 自动批准/拦截记录（右栏「自动处理记录」）
  cards = new Map<string, Card>();
  /** taskId → 本次进入执行槽的时刻（看门狗总时长用）。 */
  taskStartedAt = new Map<string, string>();
  /** taskId → 当前工人进程的停止函数（暂停/取消语义：停 10s → 杀进程树）。 */
  stopWorker = new Map<string, () => void>();
  /** taskId → 下一次派工要带给工人的备注（问题回答/拒绝说明/批准说明）。 */
  stepNotes = new Map<string, string>();
  /** 归一化工人提问 → 出现次数（L4：同一问题第 2 次升级）。 */
  workerQuestions = new Map<string, number>();
  /** 规范化命令 → 硬拦截次数（L5：第 1 次拒绝，第 2 次暂停）。 */
  permissionBlocks = new Map<string, number>();
  /** L12 队列推进中的标志（取件原子性）。 */
  pumping = false;

  constructor(entry: ProjectEntry) {
    this.entry = entry;
    this.projectDir = path.resolve(entry.path);
    fs.mkdirSync(this.projectDir, { recursive: true });
    this.store.load(this.projectDir);
    this.sessions.load(this.projectDir);
    memory.bindProject(this.projectDir);
    this.cleanupTrash();
    this.ensureGitExclude();
  }

  /** 是否有任务占用执行槽（running/verifying/fixing，需求 6.2）。 */
  get busy(): boolean {
    return this.store.list().some((t) => SLOT_STATUSES.includes(t.status));
  }

  /** trash 保留 7 天（需求 6.4 移除语义），打开项目时清理过期文件。 */
  private cleanupTrash(): void {
    try {
      const dir = projectTrashDir(this.projectDir);
      if (!fs.existsSync(dir)) return;
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      for (const f of fs.readdirSync(dir)) {
        const file = path.join(dir, f);
        try {
          if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  /** .dispatch 目录写入 .git/info/exclude（需求 16.5/5.1），避免快照与 git add 带入状态文件。 */
  ensureGitExclude(): void {
    try {
      const gitDir = path.join(this.projectDir, ".git");
      if (!fs.existsSync(gitDir)) return;
      const excludeFile = path.join(gitDir, "info", "exclude");
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
      let content = "";
      try {
        content = fs.readFileSync(excludeFile, "utf8");
      } catch {
        /* 文件不存在 */
      }
      if (!content.split(/\r?\n/).includes(".dispatch/")) {
        fs.appendFileSync(excludeFile, (content.endsWith("\n") || !content ? "" : "\n") + ".dispatch/\n");
      }
    } catch {
      /* ignore */
    }
  }
}

// ───────────────────────── 派工结果与视图 ─────────────────────────

type StepOutcome =
  | { kind: "done" }
  | { kind: "question"; question: string }
  | { kind: "blocked"; command: string; ruleLabel?: string }
  | { kind: "ask"; command: string; ruleLabel?: string }
  | { kind: "dispatch_blocked"; reason: string }
  | { kind: "failed"; error: string }
  | { kind: "stopped" };

/** 任务视图（发给前端）：去掉内部字段，附中文状态标签。 */
export function taskView(task: Task): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      ...task,
      statusLabel: TASK_STATUS_LABEL[task.status],
      criteriaWithDetail: Object.entries(task.criteriaStatus ?? {}).map(([id, v]: [string, any]) => ({
        id,
        ...v,
        text: task.criteria.find((c) => c.id === id)?.text ?? "",
      })),
    })
  );
}

function now(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 从工人最终消息提取提问（约定：最后一行以 QUESTION: 开头）。 */
function extractQuestion(lastMessage: string | undefined): string | null {
  if (!lastMessage) return null;
  const lines = lastMessage.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
    if (lines[i].startsWith(WORKER_QUESTION_PREFIX)) {
      const q = lines[i].slice(WORKER_QUESTION_PREFIX.length).trim();
      return q || null;
    }
  }
  return null;
}

// ───────────────────────── 编排器 ─────────────────────────

export class Orchestrator {
  /** 所有已添加项目的运行时（key = 解析后的项目目录）。 */
  runtimes = new Map<string, ProjectRuntime>();
  /** 全局自动批准记录（跨项目聚合展示）。 */
  ledger = new PolicyLedger();
  /** M10：请求 id → 首次执行的 Promise（60 秒窗口内重复请求直接返回首次结果）。 */
  private requestIds = new Map<string, { ts: number; promise: Promise<unknown> }>();
  /** L2 循环预算：任务尚未创建，以需求文本哈希为键（进程内；卡片流程本身不落盘）。 */
  private l2Budgets = new Map<string, Record<string, LoopRecord>>();

  // ───────────── 项目管理 ─────────────

  ensureProject(dir: string): ProjectRuntime {
    const abs = path.resolve(dir);
    let rt = this.runtimes.get(abs);
    if (!rt) {
      const list = loadProjects();
      const entry = list.find((p) => path.resolve(p.path) === abs);
      rt = new ProjectRuntime(entry ?? { path: abs, name: path.basename(abs), createdAt: now() });
      this.runtimes.set(abs, rt);
    }
    return rt;
  }

  /** 添加（或打开）项目并做重启恢复；返回运行时。 */
  addProject(dir: string): ProjectRuntime {
    const abs = path.resolve(dir);
    fs.mkdirSync(abs, { recursive: true });
    const list = loadProjects();
    if (!list.some((p) => path.resolve(p.path) === abs)) {
      list.push({ path: abs, name: path.basename(abs), createdAt: now() });
      saveProjects(list);
    }
    const rt = this.ensureProject(abs);
    this.recoverOnBoot(rt);
    info("orchestrator", `打开项目: ${abs}，任务 ${rt.store.count} 个`);
    return rt;
  }

  removeProject(dir: string): { ok: boolean; detail?: string } {
    const abs = path.resolve(dir);
    const rt = this.runtimes.get(abs);
    if (rt && rt.busy) return { ok: false, detail: "项目有任务正在执行，请先暂停或取消" };
    this.runtimes.delete(abs);
    saveProjects(loadProjects().filter((p) => path.resolve(p.path) !== abs));
    return { ok: true };
  }

  get projectDirs(): string[] {
    return [...this.runtimes.keys()];
  }

  getRuntime(dir: string): ProjectRuntime | undefined {
    return this.runtimes.get(path.resolve(dir));
  }

  // ───────────── M10 请求去重 ─────────────

  /** 同一 requestId 的并发/连点请求只执行一次（M10；60 秒窗口后允许重试）。 */
  dedupe<T>(requestId: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!requestId) return fn();
    const hit = this.requestIds.get(requestId);
    if (hit && Date.now() - hit.ts < 60_000) return hit.promise as Promise<T>;
    const promise = fn();
    this.requestIds.set(requestId, { ts: Date.now(), promise });
    if (this.requestIds.size > 500) {
      for (const [k, v] of this.requestIds) if (Date.now() - v.ts > 60_000) this.requestIds.delete(k);
    }
    return promise;
  }

  // ───────────── 状态与事件辅助 ─────────────

  private setStatus(rt: ProjectRuntime, task: Task, to: TaskStatus, reason?: string): void {
    try {
      rt.store.setStatus(task, to, reason);
    } catch (e: any) {
      warn("orchestrator", `状态迁移被拒绝（${task.status} → ${to}）：${e.message}，改为强制迁移`, task.id);
      rt.store.forceStatus(task, to, reason);
    }
    publish({ type: "task-update", projectDir: rt.projectDir, task: taskView(task) });
  }

  private saveTask(rt: ProjectRuntime, task: Task): void {
    task.counters.lastActivityAt = now();
    rt.store.saveTask(task);
  }

  private notice(rt: ProjectRuntime, level: "info" | "warn" | "error", text: string, taskId?: string): void {
    publish({ type: "notice", level, text, taskId });
  }

  private openCard(rt: ProjectRuntime, kind: Card["kind"], title: string, payload: any, taskId?: string): Card {
    const card: Card = { id: newCardId(), kind, title, payload, status: "open", createdAt: now(), taskId };
    rt.cards.set(card.id, card);
    publish({ type: "card", projectDir: rt.projectDir, card });
    return card;
  }

  private settleCard(rt: ProjectRuntime, id: string, status: Card["status"], answer?: any): Card | undefined {
    const card = rt.cards.get(id);
    if (!card) return undefined;
    card.status = status;
    if (answer !== undefined) (card as any).answer = answer;
    publish({ type: "card-update", projectDir: rt.projectDir, card });
    return card;
  }

  getOpenCards(dir: string): Card[] {
    const rt = this.runtimes.get(path.resolve(dir));
    if (!rt) return [];
    return [...rt.cards.values()].filter((c) => c.status === "open");
  }

  /** 供 API 层直接开卡（安装确认等）。 */
  openCardPublic(dir: string, kind: Card["kind"], title: string, payload: any): Card {
    return this.openCard(this.ensureProject(dir), kind, title, payload);
  }

  /** 任务级 LoopGuard：预算落盘到任务文件 loops 字段（M1，重启不重置）。 */
  private guardFor(rt: ProjectRuntime, task: Task, loopId: string, kind: string, maxIterations: number): LoopGuard {
    const guard = new LoopGuard(
      () => task.loops,
      () => {
        rt.store.saveTask(task);
        publish({ type: "loop-update", taskId: task.id, loops: task.loops });
      }
    );
    // M1：permit 前必须登记预算（未登记的循环一律拒绝，这里显式创建）
    guard.begin({ loopId, kind, maxIterations });
    return guard;
  }

  // ───────────── 对话入口（7.2） ─────────────

  /** 使用者发消息：写会话 → 压缩检查 →（忙时）意图分类分流 /（闲时）大脑协议回复。 */
  async handleUserMessage(dir: string, text: string, onDelta: (t: string) => void): Promise<void> {
    const rt = this.ensureProject(dir);
    const sessionId = this.ensureSession(rt);
    rt.sessions.append(sessionId, { kind: "user", text });
    publish({ type: "session-update", projectDir: rt.projectDir, sessionId });
    await this.maybeCompact(rt, sessionId);
    const turn = new BrainTurn(); // L11：一次使用者消息 = 一个回合，上限 8 次大脑调用
    try {
      if (rt.busy) {
        await this.handleBusyMessage(rt, sessionId, text, onDelta, turn);
      } else {
        await this.handleIdleMessage(rt, sessionId, text, onDelta, turn);
      }
    } catch (e: any) {
      rt.sessions.append(sessionId, { kind: "system", text: `调用大脑失败：${e?.message ?? e}` });
      this.notice(rt, "error", `调用大脑失败：${e?.message ?? e}`);
      throw e;
    }
  }

  /** 确保存在活动会话；新会话载入记忆摘要与任务状态摘要（9.2，不带旧对话原文）。 */
  ensureSession(rt: ProjectRuntime): string {
    if (rt.sessions.activeId) return rt.sessions.activeId;
    const id = rt.sessions.newSession("新对话");
    this.seedSessionContext(rt, id);
    return id;
  }

  /** 新建聊天：旧会话归档，新会话只带记忆摘要 + 任务状态摘要（9.2）。 */
  startNewSession(rt: ProjectRuntime): string {
    const id = rt.sessions.newSession("新对话");
    this.seedSessionContext(rt, id);
    return id;
  }

  private seedSessionContext(rt: ProjectRuntime, sessionId: string): void {
    const memDigest =
      memory.readRaw("project", 1500) || "（项目记忆为空）";
    const taskDigest = this.projectStateDigest(rt);
    rt.sessions.append(sessionId, { kind: "system", text: `已载入项目记忆：\n${memDigest}` });
    rt.sessions.append(sessionId, { kind: "system", text: `当前任务状态：\n${taskDigest}` });
    publish({ type: "session-update", projectDir: rt.projectDir, sessionId });
  }

  /** 任务状态摘要（给大脑与界面）。 */
  projectStateDigest(rt: ProjectRuntime): string {
    const tasks = rt.store.list();
    if (tasks.length === 0) return "（还没有任务）";
    return tasks
      .map((t) => {
        const crit = Object.values(t.criteriaStatus ?? {});
        const passed = crit.filter((c) => c.status === "passed").length;
        return `「${t.title}」状态=${TASK_STATUS_LABEL[t.status]}，步骤=${t.currentStepIndex}/${t.steps.length}，验收通过=${passed}/${t.criteria.length}${t.pausedReason ? `，暂停原因=${t.pausedReason}` : ""}`;
      })
      .join("\n");
  }

  /** 会话消息构造大脑输入：系统提示 + 记忆 + 最近对话行。 */
  private chatMessages(rt: ProjectRuntime, sessionId: string, extra?: { role: "user" | "system"; content: string }[]): { role: "system" | "user" | "assistant"; content: string }[] {
    const cfg = getConfig();
    const sys = [
      BRAIN_SYSTEM_PROMPT,
      `[运行环境] 大脑模型=${cfg.brain.model}；权限模式=${cfg.permissionMode === "yolo" ? "YOLO(自动批准+硬拦截)" : "分级询问"}。`,
      `[项目记忆]\n${memory.readRaw("project", 2000) || "（空）"}`,
      `[使用者偏好]\n${memory.readRaw("global", 1200) || "（空）"}`,
      `[项目状态]\n${this.projectStateDigest(rt)}`,
    ].join("\n\n");
    const history = rt.sessions
      .read(sessionId)
      .filter((l: ChatLine) => ["user", "assistant", "summary"].includes(l.kind))
      .slice(-20)
      .map((l) => ({ role: l.kind === "user" ? ("user" as const) : ("assistant" as const), content: l.text }));
    const msgs: { role: "system" | "user" | "assistant"; content: string }[] = [{ role: "system", content: sys }, ...history];
    if (extra) msgs.push(...extra);
    return msgs;
  }

  /** 流式调用大脑并增量写会话（7.4：流式增量落盘，刷新恢复已生成部分）。 */
  private async streamBrainReply(
    rt: ProjectRuntime,
    sessionId: string,
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    onDelta: (t: string) => void,
    turn: BrainTurn
  ): Promise<string> {
    const msgId = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    let full = "";
    let sent = 0;
    let lastSave = 0;
    const text = await callBrain({
      messages,
      turn,
      onDelta: (t) => {
        full += t;
        const p = extractTextProgressive(full);
        if (p.text.length > sent) {
          onDelta(p.text.slice(sent));
          sent = p.text.length;
        }
        if (Date.now() - lastSave > 400) {
          lastSave = Date.now();
          rt.sessions.append(sessionId, { kind: "assistant_delta", text: p.text, msgId });
        }
      },
    });
    const reply = parseBrainReply(text);
    const shown = reply.type === "requirement" ? reply.requirement || reply.text : reply.text;
    rt.sessions.append(sessionId, { kind: "assistant", text: shown || "（大脑没有返回内容）", msgId });
    publish({ type: "session-update", projectDir: rt.projectDir, sessionId });
    return text;
  }

  /** 空闲时的对话流：澄清 / 需求+标准（带 L2 校验） / 一般回答。 */
  private async handleIdleMessage(rt: ProjectRuntime, sessionId: string, text: string, onDelta: (t: string) => void, turn: BrainTurn): Promise<void> {
    let full = await this.streamBrainReply(rt, sessionId, this.chatMessages(rt, sessionId, [{ role: "user", content: text }]), onDelta, turn);
    let reply = parseBrainReply(full);
    // 模型偶尔跳过需求确认直接输出 plan：纠正重问一次
    if (reply.type === "plan") {
      const corrective = await callBrain({
        messages: [
          ...this.chatMessages(rt, sessionId, [{ role: "user", content: text }]),
          { role: "assistant", content: full },
          { role: "user", content: "你输出了 plan，但使用者还没有确认需求。请重新输出 requirement 类型的 JSON（先复述需求，再给出可自动检查的验收标准 criteria），不要输出 plan。" },
        ],
        turn,
      });
      full = corrective;
      reply = parseBrainReply(full);
    }
    if (reply.type === "requirement") {
      await this.presentRequirement(rt, reply);
    }
  }

  /** 需求确认卡片（L2：生成后立即校验，不合格带错误重生成 ≤2 次，仍不合格弹卡片且任务不得创建）。 */
  private async presentRequirement(rt: ProjectRuntime, reply: Extract<BrainReply, { type: "requirement" }>): Promise<void> {
    const checked = await this.ensureValidCriteria(rt, reply.requirement || reply.text, reply.criteria as any[]);
    if (!checked.ok) {
      this.openCard(rt, "decision", "验收标准无法自动检查", {
        decision: "criteria_invalid",
        requirement: reply.requirement || reply.text,
        errors: checked.errors,
        options: ["重试生成", "放弃"],
      });
      this.notice(rt, "warn", "大脑给出的验收标准未能通过校验，请补充可验证的目标（页面地址、文件、命令）。");
      return;
    }
    this.openCard(rt, "requirement", "需求确认", {
      requirement: checked.requirement,
      criteria: checked.criteria,
    });
  }

  /** L2：校验 + 重生成循环。返回合法标准，或校验错误清单（调用方弹卡片，任务不得创建）。 */
  private async ensureValidCriteria(
    rt: ProjectRuntime,
    requirement: string,
    drafts: any[]
  ): Promise<{ ok: true; criteria: Criterion[]; requirement: string } | { ok: false; errors: string[] }> {
    const key = crypto.createHash("sha1").update(requirement).digest("hex").slice(0, 12);
    let budget = this.l2Budgets.get(key);
    if (!budget) {
      budget = {};
      this.l2Budgets.set(key, budget);
    }
    const guard = new LoopGuard(() => budget!, () => {});
    const loopId = "L2";
    let current = drafts;
    let errors = validateCriteria(current);
    let text = requirement;
    for (;;) {
      if (errors.length === 0) {
        return { ok: true, criteria: normalizeCriteria(current), requirement: text };
      }
      const sig = signatureOf("criteria", "invalid", errors.join("\n"));
      const d = guard.permit(loopId, sig);
      if (!d.allowed) return { ok: false, errors };
      info("orchestrator", `验收标准未通过校验，让大脑重新生成（L2）：${errors[0]}`);
      const raw = await callBrain({ messages: criteriaRegenPrompt(requirement, current, errors) });
      const reply = parseBrainReply(raw);
      guard.record(loopId, sig);
      if (reply.type !== "requirement" || (reply.criteria as any[]).length === 0) {
        errors = ["大脑没有返回有效的 requirement JSON（含 criteria）"];
        current = [];
        continue;
      }
      current = reply.criteria as any[];
      text = reply.requirement || text;
      errors = validateCriteria(current);
    }
  }

  /** 忙时（有任务在执行槽）的意图分流（7.2）。 */
  private async handleBusyMessage(rt: ProjectRuntime, sessionId: string, text: string, onDelta: (t: string) => void, turn: BrainTurn): Promise<void> {
    const state = this.projectStateDigest(rt);
    const raw = await callBrain({
      messages: [
        { role: "system", content: `${INTENT_SYSTEM_PROMPT}\n\n[当前任务状态]\n${state}` },
        { role: "user", content: text },
      ],
      turn,
    });
    const intent = parseBrainReply(raw);
    if (intent.type !== "intent") {
      await this.replyChat(rt, sessionId, text, onDelta, turn);
      return;
    }
    if (intent.confidence < 0.6 || intent.intent === "chitchat") {
      // 置信度低：只反问一句，不猜着执行（7.2）
      const q = intent.text || "请问您是想查询进度、提出新需求，还是控制任务？";
      onDelta(q);
      rt.sessions.append(sessionId, { kind: "assistant", text: q });
      return;
    }
    switch (intent.intent) {
      case "query_progress": {
        // 代码读状态，大脑转述（不打扰工人）
        await this.replyChat(rt, sessionId, `请根据以下任务状态，用简短中文向使用者汇报当前进展：\n${state}`, onDelta, turn, true);
        return;
      }
      case "new_requirement": {
        // 新需求生成新任务排队，不插入正在运行的任务（任务创建后自动入队）
        await this.handleIdleMessage(rt, sessionId, text, onDelta, turn);
        return;
      }
      case "control": {
        const action = /暂停|停止|先停/.test(text) ? "pause" : /取消|终止|停止任务/.test(text) ? "cancel" : /恢复|继续/.test(text) ? "resume" : "";
        const target = this.matchTask(rt, intent.target ?? text);
        if (!action || !target) {
          const msg = "我理解这是控制指令，但不确定具体动作或目标任务。请说明「暂停 / 取消 / 恢复」和任务名称，或直接用任务卡片上的按钮。";
          onDelta(msg);
          rt.sessions.append(sessionId, { kind: "assistant", text: msg });
          return;
        }
        this.openCard(rt, "decision", "请确认控制操作", {
          decision: "control_confirm",
          action,
          taskId: target.id,
          taskTitle: target.title,
          options: ["确认执行", "忽略"],
        }, target.id);
        const msg = `${intent.text} 请在下方卡片确认（避免误操作）。`;
        onDelta(msg);
        rt.sessions.append(sessionId, { kind: "assistant", text: msg });
        return;
      }
      case "answer": {
        const open = [...rt.cards.values()].filter((c) => c.status === "open").pop();
        if (open) {
          await this.decide(rt.projectDir, open.id, text);
          return;
        }
        await this.replyChat(rt, sessionId, text, onDelta, turn);
        return;
      }
      default:
        await this.replyChat(rt, sessionId, text, onDelta, turn);
    }
  }

  private matchTask(rt: ProjectRuntime, target: string): Task | undefined {
    const t = (target ?? "").trim();
    if (!t) return undefined;
    const tasks = rt.store.list();
    return (
      tasks.find((x) => x.id === t) ??
      tasks.find((x) => x.title.includes(t)) ??
      tasks.find((x) => x.title && t.includes(x.title))
    );
  }

  /** 一次普通 chat 回复（可只给状态让大脑转述）。 */
  private async replyChat(rt: ProjectRuntime, sessionId: string, text: string, onDelta: (t: string) => void, turn: BrainTurn, stateOnly = false): Promise<void> {
    await this.streamBrainReply(rt, sessionId, this.chatMessages(rt, sessionId, [{ role: "user", content: text }]), onDelta, turn);
    void stateOnly;
  }

  /** L10：占用达 70% 触发一次压缩；压缩后仍超限则截断最旧行，不递归（V12）。 */
  private async maybeCompact(rt: ProjectRuntime, sessionId: string): Promise<void> {
    const cfg = getConfig().brain;
    const usage = rt.sessions.contextUsage(sessionId, cfg.maxContextTokens);
    if (!usage.overThreshold) return;
    const lines = rt.sessions.read(sessionId);
    if (lines.length <= 6) return;
    const older = lines
      .slice(0, Math.max(0, lines.length - 12))
      .map((l) => `${l.kind}: ${l.text}`)
      .join("\n")
      .slice(-12000);
    try {
      const raw = await callBrain({ messages: compactionPrompt(older) });
      const reply = parseBrainReply(raw);
      rt.sessions.compact(sessionId, reply.text, 12);
      this.notice(rt, "info", "已自动整理较早的对话（上下文压缩）。");
    } catch (e: any) {
      warn("orchestrator", `上下文压缩失败（不影响对话）：${e?.message ?? e}`);
      return;
    }
    const after = rt.sessions.contextUsage(sessionId, cfg.maxContextTokens);
    if (after.overThreshold) {
      rt.sessions.truncateOldest(sessionId, 20);
      this.notice(rt, "warn", "压缩后上下文仍超限，已截断最早的记录（不再递归压缩）。");
    }
  }

  // ───────────── 需求确认 → 任务创建 ─────────────

  /** 使用者点击需求确认卡片：创建任务并入队（M10 由 server 层传 requestId）。 */
  async confirmRequirement(dir: string, cardId: string): Promise<void> {
    const rt = this.ensureProject(dir);
    const card = rt.cards.get(cardId);
    if (!card || card.kind !== "requirement" || card.status !== "open") return;
    this.settleCard(rt, cardId, "confirmed");
    await this.startTask(rt, card.payload.requirement, card.payload.criteria);
  }

  /** 创建任务：L2 校验（防御性）→ 建 queued 任务 → 拆步骤 → git 快照 → 入队。 */
  async startTask(rt: ProjectRuntime, requirement: string, drafts: any[]): Promise<Task> {
    const checked = await this.ensureValidCriteria(rt, requirement, drafts ?? []);
    if (!checked.ok) {
      this.openCard(rt, "decision", "验收标准无法自动检查", {
        decision: "criteria_invalid",
        requirement,
        errors: checked.errors,
        options: ["重试生成", "放弃"],
      });
      throw new Error(`验收标准未通过校验：${checked.errors[0]}`);
    }
    const task = rt.store.create({
      projectId: projectIdOf(rt.projectDir),
      title: requirement.slice(0, 60) || "新任务",
      requirement: checked.requirement,
      criteria: checked.criteria,
      steps: [],
    });
    publish({ type: "task-update", projectDir: rt.projectDir, task: taskView(task) });
    let steps = await this.planSteps(rt, task);
    const limit = getConfig().limits.maxStepsPerTask;
    if (steps.length > limit) {
      this.notice(rt, "warn", `大脑给出的步骤数 ${steps.length} 超过上限 ${limit}，已截断。`);
      steps = steps.slice(0, limit);
    }
    task.steps = steps;
    this.saveTask(rt, task);
    publish({ type: "task-update", projectDir: rt.projectDir, task: taskView(task) });
    await this.snapshotTask(rt, task);
    this.notice(rt, "info", `任务「${task.title}」已创建并入队（${steps.length} 个步骤）。`);
    this.pumpQueue(rt);
    return task;
  }

  /** 大脑拆解步骤（单次调用，失败退化为单步——不构成循环）。 */
  private async planSteps(rt: ProjectRuntime, task: Task): Promise<Step[]> {
    try {
      const raw = await callBrain({
        messages: [
          {
            role: "user",
            content: `使用者已确认以下需求，请输出 plan 类型 JSON，把任务拆解为 2~6 个给工人的步骤（instruction 要具体到文件与功能，并告知工人只能在项目目录内创建/修改文件）：\n【需求】${task.requirement}\n【验收标准】${JSON.stringify(task.criteria)}`,
          },
        ],
      });
      const reply = parseBrainReply(raw);
      if (reply.type === "plan" && reply.steps.length > 0) {
        return reply.steps.map((s, i) => ({
          id: String(s.id ?? `S${i + 1}`),
          title: String(s.title ?? `步骤${i + 1}`),
          instruction: String(s.instruction ?? s.title ?? ""),
          status: "todo" as const,
        }));
      }
      warn("orchestrator", `大脑未返回 plan（返回 ${reply.type}），退化为单步执行`, task.id);
    } catch (e: any) {
      warn("orchestrator", `拆解步骤失败，退化为单步执行：${e?.message ?? e}`, task.id);
    }
    return [{ id: "S1", title: "实现需求", instruction: task.requirement, status: "todo" as const }];
  }

  // ───────────── 队列与执行槽（L12） ─────────────

  /** 队列推进：取第一个 queued 任务，原子改状态为 running 并启动主循环。 */
  pumpQueue(rt: ProjectRuntime): void {
    if (rt.pumping) return;
    rt.pumping = true;
    try {
      if (rt.busy) return;
      const next = rt.store.list().find((t) => t.status === "queued");
      if (!next) return;
      info("orchestrator", `队列取件：${next.id}「${next.title}」`, next.id);
      this.setStatus(rt, next, "running", "从队列取出开始执行");
      void this.runTask(rt, next);
    } finally {
      rt.pumping = false;
    }
  }

  // ───────────── 任务主循环 ─────────────

  /** 任务主循环：顺序执行步骤 → 全部完成后验收与修复（8.1）。 */
  private async runTask(rt: ProjectRuntime, task: Task): Promise<void> {
    rt.taskStartedAt.set(task.id, now());
    try {
      for (let si = task.currentStepIndex; si < task.steps.length; si++) {
        if (!SLOT_STATUSES.includes(task.status)) return; // 已被暂停/取消/等待决策
        const step = task.steps[si];
        task.currentStepIndex = si;
        step.status = "in_progress";
        this.saveTask(rt, task);
        publish({ type: "step-update", projectDir: rt.projectDir, taskId: task.id, step });
        publish({ type: "task-update", projectDir: rt.projectDir, task: taskView(task) });

        const note = rt.stepNotes.get(task.id);
        rt.stepNotes.delete(task.id);
        let prompt = this.workerStepPrompt(rt, task, step);
        if (note) prompt += `\n\n【调度中心转告】${note}`;
        let outcome: StepOutcome | null = await this.runWorkerStep(rt, task, step, prompt, task.workerSessionRef);
        outcome = await this.handleStepOutcome(rt, task, step, outcome, prompt);
        if (!outcome) return; // 本步已转入等待/暂停，决策后由 decide() 恢复
        step.status = "passed";
        step.detail = "工人执行完成";
        this.saveTask(rt, task);
        publish({ type: "step-update", projectDir: rt.projectDir, taskId: task.id, step });
      }
      if (!SLOT_STATUSES.includes(task.status)) return;
      await this.verifyAndFix(rt, task);
    } catch (e: any) {
      await this.onRuntimeCrash(rt, task, e);
    } finally {
      rt.taskStartedAt.delete(task.id);
      this.pumpQueue(rt); // 槽位释放，推进队列（L12）
    }
  }

  /**
   * 处理单次派工结果：提问代答(L4)、硬拦截拒绝(L5)、启动失败重试(L6)、
   * 调度侧缺陷回报(8.3)。返回 null 表示任务已转入等待/暂停；返回 done 表示本步完成。
   */
  private async handleStepOutcome(rt: ProjectRuntime, task: Task, step: Step, outcome: StepOutcome, basePrompt: string): Promise<StepOutcome | null> {
    for (;;) {
      switch (outcome.kind) {
        case "done":
          return outcome;
        case "stopped":
          return null;
        case "dispatch_blocked": {
          // 8.3/V14：工人回报问题在调度侧 → 不计修复次数，弹决策卡片
          this.notice(rt, "warn", `工人回报调度侧问题（不计入修复次数）：${outcome.reason}`, task.id);
          this.setStatus(rt, task, "waiting_user", `工人回报调度侧缺陷：${outcome.reason}`);
          task.pausedReason = `DISPATCH_BLOCKED：${outcome.reason}`;
          this.saveTask(rt, task);
          this.openCard(rt, "decision", "工人判断问题出在调度中心一侧", {
            decision: "dispatch_blocked",
            taskId: task.id,
            reason: outcome.reason,
            options: ["再试一次", "取消任务"],
          }, task.id);
          return null;
        }
        case "question": {
          const answer = await this.answerWorkerQuestion(rt, task, outcome.question);
          if (answer === null) return null; // 已升级为决策卡片（L4）
          rt.stepNotes.set(task.id, `你此前提问「${outcome.question}」，调度中心的回答：${answer}。请继续完成当前步骤。`);
          outcome = await this.runWorkerStep(rt, task, step, basePrompt, task.workerSessionRef);
          continue;
        }
        case "blocked": {
          const firstRefusal = this.handleHardBlock(rt, task, outcome.command);
          if (!firstRefusal) return null; // 第 2 次请求同一被拦截操作 → 已暂停（L5）
          rt.stepNotes.set(task.id, `该操作被禁止（${outcome.command}）。请换一种不会触发安全规则的方案完成目标。`);
          outcome = await this.runWorkerStep(rt, task, step, basePrompt, task.workerSessionRef);
          continue;
        }
        case "ask": {
          // 分级模式：等待使用者决策（6.5 卡片）
          this.setStatus(rt, task, "waiting_user", `工人请求执行「${outcome.ruleLabel ?? outcome.command}」，等待你的决定`);
          task.pausedReason = `等待权限决定：${outcome.command}`;
          this.saveTask(rt, task);
          this.openCard(rt, "decision", "工人请求权限", {
            decision: "ask_permission",
            taskId: task.id,
            command: outcome.command,
            ruleLabel: outcome.ruleLabel,
            options: ["批准并继续", "拒绝"],
          }, task.id);
          this.notice(rt, "warn", `分级模式：工人请求执行「${outcome.ruleLabel ?? outcome.command}」，已暂停等待你的决定。`, task.id);
          return null;
        }
        case "failed": {
          const retry = await this.retryWorkerStart(rt, task, outcome.error);
          if (!retry) return null; // L6 用尽 → 已暂停
          outcome = await this.runWorkerStep(rt, task, step, basePrompt, task.workerSessionRef);
          continue;
        }
      }
    }
  }

  // ───────────── 工人派工 ─────────────

  /** 执行一次工人调用，把 JSONL 事件转发到事件总线；返回结构化结果。 */
  private runWorkerStep(rt: ProjectRuntime, task: Task, step: Step, prompt: string, resumeThreadId?: string): Promise<StepOutcome> {
    void step;
    const cfg = getConfig();
    const adapter = getAdapter(cfg.worker.kind);
    task.counters.workerCalls += 1;
    this.saveTask(rt, task);
    info("orchestrator", `派工 #${task.counters.workerCalls}（${resumeThreadId ? "续聊" : "新会话"}）`, task.id);
    return new Promise<StepOutcome>((resolve) => {
      let sawBlock: { command: string; ruleLabel?: string } | null = null;
      let sawAsk: { command: string; ruleLabel?: string } | null = null;
      const handle = adapter.run({
        projectDir: rt.projectDir,
        prompt,
        mode: cfg.permissionMode,
        resumeThreadId,
        onEvent: (e: WorkerEvent) => {
          const r = this.onWorkerEvent(rt, task, e);
          if (r.blocked) sawBlock = r.blocked;
          if (r.ask) sawAsk = r.ask;
        },
      });
      rt.stopWorker.set(task.id, handle.stop);
      handle.result
        .then((res) => {
          rt.stopWorker.delete(task.id);
          if (res.threadId) {
            task.workerSessionRef = res.threadId;
          }
          this.saveTask(rt, task);
          if (sawBlock) return resolve({ kind: "blocked", command: sawBlock.command, ruleLabel: sawBlock.ruleLabel });
          if (sawAsk) return resolve({ kind: "ask", command: sawAsk.command, ruleLabel: sawAsk.ruleLabel });
          if (res.dispatchBlocked) return resolve({ kind: "dispatch_blocked", reason: res.dispatchBlocked });
          if (res.ok) {
            const q = extractQuestion(res.lastMessage);
            if (q) return resolve({ kind: "question", question: q });
            return resolve({ kind: "done" });
          }
          if (res.error) return resolve({ kind: "failed", error: res.error });
          // 无 error 的失败：多半是被暂停/取消/看门狗停止
          if (!SLOT_STATUSES.includes(task.status)) return resolve({ kind: "stopped" });
          return resolve({ kind: "failed", error: `工人异常退出（退出码非 0${res.lastMessage ? `，最后输出：${res.lastMessage.slice(0, 200)}` : ""}）` });
        })
        .catch((e) => resolve({ kind: "failed", error: String(e?.message ?? e) }));
    });
  }

  /** 工人事件 → 右栏展示 + 自动批准记录（15.2）；返回本事件携带的拦截/询问信息供派工判定。 */
  private onWorkerEvent(rt: ProjectRuntime, task: Task, e: WorkerEvent): { blocked?: { command: string; ruleLabel?: string }; ask?: { command: string; ruleLabel?: string } } {
    task.counters.lastWorkerOutputAt = now();
    task.counters.lastActivityAt = now();
    switch (e.kind) {
      case "message":
        publish({ type: "worker-output", projectDir: rt.projectDir, taskId: task.id, text: e.text ?? "" });
        break;
      case "reasoning":
        publish({ type: "worker-output", projectDir: rt.projectDir, taskId: task.id, text: `[思考] ${e.text ?? ""}` });
        break;
      case "command": {
        publish({
          type: "worker-command",
          projectDir: rt.projectDir,
          taskId: task.id,
          command: e.command ?? "",
          output: e.output,
          exitCode: e.exitCode,
        });
        // YOLO：命令已自动放行，完整记录（需求 15.2）
        if (getConfig().permissionMode === "yolo" && e.exitCode !== undefined) {
          const rec = this.ledger.record("yolo", "allow", e.command ?? "");
          rt.ledger.record("yolo", "allow", e.command ?? "");
          publish({ type: "auto-approve", projectDir: rt.projectDir, taskId: task.id, action: e.command ?? "", rule: rec.ruleLabel ?? "" });
        }
        break;
      }
      case "error":
        publish({ type: "worker-output", projectDir: rt.projectDir, taskId: task.id, text: `[错误] ${e.text ?? ""}` });
        break;
      case "fatal":
        publish({ type: "worker-output", projectDir: rt.projectDir, taskId: task.id, text: `[致命] ${e.text ?? ""}` });
        break;
      case "permission": {
        // 硬拦截事件已由适配器层即时终止工人进程；此处记录并回传给派工流程（L5）
        if (e.verdict === "block") {
          rt.ledger.record(getConfig().permissionMode, "block", e.command ?? "");
          publish({ type: "hard-block", projectDir: rt.projectDir, taskId: task.id, action: e.command ?? "", rule: `${e.ruleId ?? ""} ${e.ruleLabel ?? ""}` });
          return { blocked: { command: e.command ?? "", ruleLabel: e.ruleLabel } };
        }
        if (e.verdict === "ask") {
          return { ask: { command: e.command ?? "", ruleLabel: e.ruleLabel } };
        }
        break;
      }
      default:
        break;
    }
    return {};
  }

  // ───────────── L4 工人提问代答 ─────────────

  /**
   * 大脑代答工人的提问（L4）：单任务 ≤15 次；同一问题（归一化后相同）第 2 次直接升级；
   * 大脑回答「不确定」立即升级。返回 null 表示已升级为决策卡片。
   */
  private async answerWorkerQuestion(rt: ProjectRuntime, task: Task, question: string): Promise<string | null> {
    const key = normalizeErrorText(question) || EMPTY_SIGNATURE;
    const seen = rt.workerQuestions.get(key) ?? 0;
    rt.workerQuestions.set(key, seen + 1);
    if (seen >= 1) {
      this.escalateQuestion(rt, task, question, "工人重复提出同一个问题，自动代答已停止");
      return null;
    }
    const guard = this.guardFor(rt, task, "L4", "L4", getConfig().limits.maxWorkerQuestions);
    const sig = signatureOf("question", "worker", question);
    const d = guard.permit("L4", sig);
    if (!d.allowed) {
      this.escalateQuestion(rt, task, question, d.reason ?? "提问次数已达上限");
      return null;
    }
    try {
      const turn = new BrainTurn();
      const raw = await callBrain({
        messages: workerQuestionPrompt(question, `任务「${task.title}」：${task.requirement}\n当前步骤：${task.steps[task.currentStepIndex]?.title ?? ""}`),
        turn,
      });
      guard.record("L4", sig);
      task.counters.brainCalls += 1;
      this.saveTask(rt, task);
      const reply = parseBrainReply(raw);
      if (reply.type !== "answer" || reply.unsure || /不确定|无法确定/.test(reply.answer)) {
        this.escalateQuestion(rt, task, question, "大脑无法给出确定答案");
        return null;
      }
      const sessionId = this.ensureSession(rt);
      rt.sessions.append(sessionId, { kind: "system", text: `工人提问「${question}」，大脑已代答：${reply.answer}` });
      publish({ type: "session-update", projectDir: rt.projectDir, sessionId });
      info("orchestrator", `大脑代答工人提问（L4）：${question.slice(0, 50)}`, task.id);
      return reply.answer;
    } catch (e: any) {
      warn("orchestrator", `大脑代答失败：${e?.message ?? e}`, task.id);
      this.escalateQuestion(rt, task, question, `大脑代答失败：${e?.message ?? e}`);
      return null;
    }
  }

  /** 提问升级：等待使用者回答（waiting_user + 决策卡片）。 */
  private escalateQuestion(rt: ProjectRuntime, task: Task, question: string, reason: string): void {
    this.notice(rt, "warn", `工人提问需要你决定：${question}（${reason}）`, task.id);
    this.setStatus(rt, task, "waiting_user", `工人提问升级：${reason}`);
    task.pausedReason = `工人提问：${question}`;
    this.saveTask(rt, task);
    this.openCard(rt, "decision", "工人有一个问题需要你回答", {
      decision: "worker_question",
      taskId: task.id,
      question,
      reason,
      options: ["取消任务"],
    }, task.id);
  }

  // ───────────── L5 硬拦截处理 ─────────────

  /**
   * 硬拦截后的处理（L5）：同一被拦截操作第 1 次 → 拒绝并让工人换方案；
   * 第 2 次 → 暂停任务并通知使用者。返回 true 表示已给出拒绝回复（可继续）。
   */
  private handleHardBlock(rt: ProjectRuntime, task: Task, command: string): boolean {
    const key = normalizeErrorText(command);
    const n = (rt.permissionBlocks.get(key) ?? 0) + 1;
    rt.permissionBlocks.set(key, n);
    rt.ledger.record(getConfig().permissionMode, "block", command);
    publish({ type: "hard-block", projectDir: rt.projectDir, taskId: task.id, action: command, rule: "硬拦截规则" });
    if (n >= 2) {
      this.notice(rt, "error", `工人再次请求被禁止的操作（${command}），任务已暂停。`, task.id);
      this.pauseTask(rt, task, `工人重复请求被禁止的操作：${command}`, {
        decision: "hard_block",
        taskId: task.id,
        command,
        options: ["保持暂停", "取消任务"],
      });
      return false;
    }
    this.notice(rt, "warn", `已拦截危险操作并通知工人换方案：${command}`, task.id);
    return true;
  }

  // ───────────── L6 工人启动失败重试 ─────────────

  /** 工人执行失败的重试（L6：最多 2 次，按 M9 退避 1s/4s）。返回 false 表示已暂停。 */
  private async retryWorkerStart(rt: ProjectRuntime, task: Task, error: string): Promise<boolean> {
    const guard = this.guardFor(rt, task, "L6", "L6", 2); // 需求 L6：启动失败最多重试 2 次
    const sig = signatureOf("worker", "start-failure", error);
    const d = guard.permit("L6", sig);
    if (!d.allowed) {
      // L6 用尽 → 暂停 + 卡片，附最近一次心跳结果（需求 10.3）
      const hb: HeartbeatRecord | undefined = heartbeat.lastRecord();
      this.notice(rt, "error", `工人连续失败，任务已暂停：${error}`, task.id);
      this.pauseTask(rt, task, `工人不可用：${error}`, {
        decision: "worker_unavailable",
        taskId: task.id,
        error,
        heartbeat: hb ? hb.items.map((i) => `${i.name}:${i.ok ? "正常" : "异常"}`).join("，") : "（暂无心跳记录）",
        options: ["重试", "取消任务"],
      });
      return false;
    }
    guard.record("L6", sig);
    const iteration = guard.get("L6")?.iteration ?? 1;
    const delay = [1000, 4000][Math.min(iteration - 1, 1)]; // M9 退避 1s/4s
    this.notice(rt, "warn", `工人执行失败（${error}），${delay / 1000} 秒后重试（第 ${iteration}/2 次）。`, task.id);
    await sleep(delay);
    return true;
  }

  // ───────────── 验收与修复（8.1 分流 + L1/L3） ─────────────

  /** 验收主循环：verify → 分流 →（L3 调度侧 / L1 修复）→ 再 verify。 */
  private async verifyAndFix(rt: ProjectRuntime, task: Task): Promise<void> {
    for (;;) {
      if (!SLOT_STATUSES.includes(task.status)) return;
      this.setStatus(rt, task, "verifying", "运行自动验收");
      const report: AcceptanceReport = await runAcceptance(rt.projectDir, task, rt.entry.startCommand);
      publish({ type: "acceptance", projectDir: rt.projectDir, taskId: task.id, report });
      // 更新每条标准的展示状态
      for (const r of report.results) {
        task.criteriaStatus[r.criterionId] = { status: r.passed ? "passed" : "failed", detail: r.detail, evidence: r.evidence };
      }
      this.saveTask(rt, task);

      if (report.allPassed) {
        this.setStatus(rt, task, "passed", "验收标准全部通过");
        this.notice(rt, "info", `任务「${task.title}」验收全部通过，已完成。`, task.id);
        this.consolidateMemory(rt, task, `任务「${task.title}」已通过验收。需求：${task.requirement.slice(0, 200)}`);
        return;
      }

      if (report.internalError) {
        // 8.1 第 4 条 / V5：有失败但既无 problems 也无 harnessErrors → 内部错误，暂停，不派工人
        warn("acceptance", `验收报告内部错误：${report.internalError}`, task.id);
        this.notice(rt, "error", `验收报告内部错误（0 次工人调用，任务暂停）：${report.internalError}`, task.id);
        this.setStatus(rt, task, "waiting_user", `验收内部错误：${report.internalError}`);
        task.pausedReason = `验收内部错误：${report.internalError}`;
        this.saveTask(rt, task);
        this.openCard(rt, "decision", "验收器内部错误", {
          decision: "resume_task",
          taskId: task.id,
          reason: report.internalError,
          options: ["重新验收", "取消任务"],
        }, task.id);
        return;
      }

      if (report.harnessErrors.length > 0) {
        // 8.1 第 2 条：调度侧缺陷 → L3，绝不派工人
        const cont = await this.handleHarnessErrors(rt, task, report);
        if (!cont) return;
        continue; // 标准已修复 → 重新验收
      }

      if (report.problems.length > 0) {
        // 8.1 第 3 条：项目缺陷 → L1 修复循环（入口硬规则：problems 非空才派工人）
        const cont = await this.fixOnce(rt, task, report);
        if (!cont) return;
        continue; // 修复后重新验收
      }

      // 防御分支：分类失败但 classifyReport 未标记（不应发生）
      this.notice(rt, "error", "验收失败且无法归类问题，任务已暂停（不派工人）。", task.id);
      this.setStatus(rt, task, "waiting_user", "验收失败且无法归类（防御分支）");
      this.saveTask(rt, task);
      this.openCard(rt, "decision", "验收失败且无法归类", {
        decision: "resume_task",
        taskId: task.id,
        reason: "验收失败但 problems 与 harnessErrors 均为空",
        options: ["重新验收", "取消任务"],
      }, task.id);
      return;
    }
  }

  /**
   * L3：调度侧缺陷处理。最多触发 1 次让大脑重新生成该标准（limits.maxHarnessRegen）；
   * 仍有缺陷则暂停 + 决策卡片（M5）。这一路永远不进入 L1。
   * 返回 true 表示标准已更新、应重新验收；false 表示已转入等待。
   */
  private async handleHarnessErrors(rt: ProjectRuntime, task: Task, report: AcceptanceReport): Promise<boolean> {
    const errors = report.harnessErrors;
    const maxRegen = Math.max(0, getConfig().limits.maxHarnessRegen);
    const guard = this.guardFor(rt, task, "L3", "L3", maxRegen);
    const sig = signatureOf("harness", errors.map((h) => h.code).join(","), errors.map((h) => h.detail).join("\n"));
    const d = guard.permit("L3", sig);
    if (!d.allowed) {
      this.notice(rt, "error", `调度侧缺陷修复已达上限，任务暂停：${errors.map((h) => h.detail).join("；")}`, task.id);
      this.pauseTask(rt, task, `调度侧缺陷未解决：${errors[0]?.detail ?? ""}`, {
        decision: "loop_stop",
        loopId: "L3",
        kind: "L3 调度侧缺陷",
        reason: d.reason,
        errors,
        options: ["重试一次", "取消任务"],
      });
      return false;
    }
    this.notice(rt, "warn", `发现调度侧缺陷（不派工人），让大脑重新生成验收标准（L3，最多 ${maxRegen} 次）：${errors[0]?.detail ?? ""}`, task.id);
    try {
      const raw = await callBrain({
        messages: criteriaRegenPrompt(task.requirement, task.criteria, errors.map((h) => `${h.criterionId}: ${h.code} ${h.detail}`)),
      });
      guard.record("L3", sig);
      task.counters.brainCalls += 1;
      this.saveTask(rt, task);
      const reply = parseBrainReply(raw);
      if (reply.type !== "requirement") {
        warn("orchestrator", "大脑未返回 requirement，L3 无法继续", task.id);
        return this.harnessRegenFailed(rt, task, errors);
      }
      const errs = validateCriteria(reply.criteria as any[]);
      if (errs.length > 0) {
        return this.harnessRegenFailed(rt, task, errors);
      }
      // 应用新标准：重建 criteriaStatus（保留已通过项的结论）
      const newCriteria = normalizeCriteria(reply.criteria as any[]);
      const oldStatus = { ...task.criteriaStatus };
      task.criteria = newCriteria;
      task.criteriaStatus = {};
      for (const c of newCriteria) {
        const old = oldStatus[c.id];
        task.criteriaStatus[c.id] = old && old.status === "passed" ? old : { status: "pending" as const };
      }
      this.saveTask(rt, task);
      publish({ type: "task-update", projectDir: rt.projectDir, task: taskView(task) });
      info("orchestrator", "L3：验收标准已重新生成，重新验收", task.id);
      return true;
    } catch (e: any) {
      guard.record("L3", sig);
      warn("orchestrator", `L3 重新生成失败：${e?.message ?? e}`, task.id);
      return this.harnessRegenFailed(rt, task, errors);
    }
  }

  private harnessRegenFailed(rt: ProjectRuntime, task: Task, errors: { criterionId: string; code: string; detail: string }[]): boolean {
    this.notice(rt, "error", `调度侧缺陷未能自动修复，任务暂停：${errors[0]?.detail ?? ""}`, task.id);
    this.pauseTask(rt, task, `调度侧缺陷（重新生成标准失败）：${errors[0]?.detail ?? ""}`, {
      decision: "loop_stop",
      loopId: "L3",
      kind: "L3 调度侧缺陷",
      reason: "让大脑重新生成标准仍不合格",
      errors,
      options: ["重试一次", "取消任务"],
    });
    return false;
  }

  /**
   * L1：验收→修复循环的单轮。 permit 检查（总修复 ≤6、同签名 ≤3、无进展上限、振荡），
   * 全部通过才派工人；修复后对比 changedFiles（8.4），空改动=无进展（V3）。
   * 返回 true 表示应重新验收；false 表示已暂停/等待。
   */
  private async fixOnce(rt: ProjectRuntime, task: Task, report: AcceptanceReport): Promise<boolean> {
    const problems = report.problems;
    const sig = signatureOfProblems(problems);
    if (sig === EMPTY_SIGNATURE) {
      // EMPTY 永不合法（M2/L1）：按调度侧缺陷处理，不派工人
      this.notice(rt, "error", "问题内容为空（签名 EMPTY），不派工人，按调度侧缺陷暂停。", task.id);
      this.pauseTask(rt, task, "验收问题内容为空（签名 EMPTY）", {
        decision: "loop_stop",
        loopId: "L1",
        kind: "L1 修复循环",
        reason: "问题内容为空，EMPTY 签名不允许进入修复循环",
        options: ["重新验收", "取消任务"],
      });
      return false;
    }
    const cfg = getConfig().limits;
    const sigLoopId = `L1-sig-${sig}`;
    // 振荡检测（M3/V4）：A→B→A —— 新签名与前一次不同但与前第二次相同 → 拒绝派工。
    // 必须在申请任何预算之前判定：振荡即停，不消耗修复轮数。
    // 依据：签名预算按 L1-sig-<sig> 分桶（各自计数「同一签名 ≤3 次」），
    // 振荡序列跨签名，须另设任务级全局序列记录（L1-sigs）保存最近签名历史。
    const sigHistory = this.guardFor(rt, task, "L1-sigs", "L1", cfg.maxTotalFixes + 2);
    const histPre = sigHistory.get("L1-sigs");
    const sigs = histPre?.signatures ?? [];
    if (sigs.length >= 2 && sigs[sigs.length - 1] !== sig && sigs[sigs.length - 2] === sig) {
      sigHistory.stop("L1-sigs", `出现 A→B→A 振荡（签名 ${sig} 第二次出现）`);
      this.stopFixLoop(rt, task, "修复签名来回振荡", `签名 ${sig} 第二次出现（A→B→A 振荡）`, sig, problems.length);
      return false;
    }
    const total = this.guardFor(rt, task, "L1-total", "L1", cfg.maxTotalFixes);
    const sigGuard = this.guardFor(rt, task, sigLoopId, "L1", cfg.maxFixPerSignature);
    const dTotal = total.permit("L1-total", sig);
    if (!dTotal.allowed) {
      this.stopFixLoop(rt, task, "总修复轮数已达上限", dTotal.reason!, sig, problems.length);
      return false;
    }
    const dSig = sigGuard.permit(sigLoopId, sig);
    if (!dSig.allowed) {
      this.stopFixLoop(rt, task, "同一问题修复次数已达上限", dSig.reason!, sig, problems.length);
      return false;
    }

    this.setStatus(rt, task, "fixing", `派工人修复（签名 ${sig.slice(0, 8)}）`);
    const beforeTree = await this.gitTree(rt, task); // 修复前快照（8.4）
    const attemptNo = (sigGuard.get(sigLoopId)?.iteration ?? 0) + 1;
    const step = task.steps[Math.min(task.currentStepIndex, Math.max(0, task.steps.length - 1))] ?? ({ id: "FIX", title: "修复", instruction: "", status: "todo" } as Step);
    const prompt = this.workerFixPrompt(rt, task, problems, attemptNo);
    const startedAt = now();
    const outcome = await this.runWorkerStep(rt, task, step, prompt, task.workerSessionRef);

    if (outcome.kind === "dispatch_blocked") {
      // V14：调度侧缺陷回报不计入修复次数（不 record）
      this.notice(rt, "warn", `工人回报调度侧问题（不计入修复次数）：${outcome.reason}`, task.id);
      this.setStatus(rt, task, "waiting_user", `工人回报调度侧缺陷：${outcome.reason}`);
      task.pausedReason = `DISPATCH_BLOCKED：${outcome.reason}`;
      this.saveTask(rt, task);
      this.openCard(rt, "decision", "工人判断问题出在调度中心一侧", {
        decision: "dispatch_blocked",
        taskId: task.id,
        reason: outcome.reason,
        options: ["重新验收", "取消任务"],
      }, task.id);
      return false;
    }
    if (outcome.kind === "question") {
      const answer = await this.answerWorkerQuestion(rt, task, outcome.question);
      if (answer === null) return false;
      // 带着答案重新派一次修复（本次不计数，下次派工再计数）
      rt.stepNotes.set(task.id, `你此前提问「${outcome.question}」，调度中心的回答：${answer}。请继续完成修复。`);
      const outcome2 = await this.runWorkerStep(rt, task, step, prompt, task.workerSessionRef);
      return this.afterFixDispatch(rt, task, sig, sigGuard, total, beforeTree, outcome2, startedAt, prompt, problems);
    }
    if (outcome.kind === "blocked") {
      const firstRefusal = this.handleHardBlock(rt, task, outcome.command);
      if (!firstRefusal) return false;
      rt.stepNotes.set(task.id, `该操作被禁止（${outcome.command}）。请换一种不会触发安全规则的方案完成修复。`);
      const outcome2 = await this.runWorkerStep(rt, task, step, prompt, task.workerSessionRef);
      return this.afterFixDispatch(rt, task, sig, sigGuard, total, beforeTree, outcome2, startedAt, prompt, problems);
    }
    if (outcome.kind === "ask") {
      this.setStatus(rt, task, "waiting_user", `工人请求执行「${outcome.ruleLabel ?? outcome.command}」，等待你的决定`);
      task.pausedReason = `等待权限决定：${outcome.command}`;
      this.saveTask(rt, task);
      this.openCard(rt, "decision", "工人请求权限", {
        decision: "ask_permission",
        taskId: task.id,
        command: outcome.command,
        ruleLabel: outcome.ruleLabel,
        options: ["批准并继续", "拒绝"],
      }, task.id);
      return false;
    }
    if (outcome.kind === "failed") {
      const retry = await this.retryWorkerStart(rt, task, outcome.error);
      if (!retry) return false;
      const outcome2 = await this.runWorkerStep(rt, task, step, prompt, task.workerSessionRef);
      return this.afterFixDispatch(rt, task, sig, sigGuard, total, beforeTree, outcome2, startedAt, prompt, problems);
    }
    if (outcome.kind === "stopped") return false;
    return this.afterFixDispatch(rt, task, sig, sigGuard, total, beforeTree, outcome, startedAt, prompt, problems);
  }

  /** 修复派工完成后的记账：签名、次数、changedFiles、无进展判定（M2/M3/8.4/V2/V3）。 */
  private async afterFixDispatch(
    rt: ProjectRuntime,
    task: Task,
    sig: string,
    sigGuard: LoopGuard,
    total: LoopGuard,
    beforeTree: string | null,
    outcome: StepOutcome,
    startedAt: string,
    prompt: string,
    problems: { criterionId: string; summary: string; expected: string; actual: string; evidence?: string }[]
  ): Promise<boolean> {
    const sigLoopId = `L1-sig-${sig}`;
    if (outcome.kind === "dispatch_blocked") {
      // 8.3/V14：不计入修复次数
      this.notice(rt, "warn", `工人回报调度侧问题（不计入修复次数）：${outcome.reason}`, task.id);
      this.setStatus(rt, task, "waiting_user", `工人回报调度侧缺陷：${outcome.reason}`);
      task.pausedReason = `DISPATCH_BLOCKED：${outcome.reason}`;
      this.saveTask(rt, task);
      this.openCard(rt, "decision", "工人判断问题出在调度中心一侧", {
        decision: "dispatch_blocked",
        taskId: task.id,
        reason: outcome.reason,
        options: ["重新验收", "取消任务"],
      }, task.id);
      return false;
    }
    if (outcome.kind === "question") {
      const answer = await this.answerWorkerQuestion(rt, task, outcome.question);
      if (answer === null) return false;
      rt.stepNotes.set(task.id, `你此前提问「${outcome.question}」，调度中心的回答：${answer}。请继续完成修复。`);
      const outcome2 = await this.runWorkerStep(rt, task, task.steps[Math.min(task.currentStepIndex, Math.max(0, task.steps.length - 1))], prompt, task.workerSessionRef);
      return this.afterFixDispatch(rt, task, sig, sigGuard, total, beforeTree, outcome2, startedAt, prompt, problems);
    }
    if (outcome.kind === "blocked") {
      const firstRefusal = this.handleHardBlock(rt, task, outcome.command);
      if (!firstRefusal) return false;
      rt.stepNotes.set(task.id, `该操作被禁止（${outcome.command}）。请换一种不会触发安全规则的方案完成修复。`);
      const outcome2 = await this.runWorkerStep(rt, task, task.steps[Math.min(task.currentStepIndex, Math.max(0, task.steps.length - 1))], prompt, task.workerSessionRef);
      return this.afterFixDispatch(rt, task, sig, sigGuard, total, beforeTree, outcome2, startedAt, prompt, problems);
    }
    if (outcome.kind === "failed") {
      const retry = await this.retryWorkerStart(rt, task, outcome.error);
      if (!retry) return false;
      const outcome2 = await this.runWorkerStep(rt, task, task.steps[Math.min(task.currentStepIndex, Math.max(0, task.steps.length - 1))], prompt, task.workerSessionRef);
      return this.afterFixDispatch(rt, task, sig, sigGuard, total, beforeTree, outcome2, startedAt, prompt, problems);
    }
    if (outcome.kind === "stopped") return false;

    // done：记账（只有正常完成才算一次修复动作）
    total.record("L1-total", sig);
    sigGuard.record(sigLoopId, sig);
    // 全局签名序列（M3 振荡检测的数据源）；guardFor 幂等，这里取回 fixOnce 创建的 L1-sigs 预算
    this.guardFor(rt, task, "L1-sigs", "L1", getConfig().limits.maxTotalFixes + 2).record("L1-sigs", sig);
    const afterTree = await this.gitTree(rt, task);
    const changedFiles = beforeTree && afterTree ? await this.changedFiles(rt, beforeTree, afterTree) : [];
    task.fixAttempts.push({
      seq: task.fixAttempts.length + 1,
      signature: sig,
      changedFiles,
      startedAt,
      endedAt: now(),
      summary: (problems.map((p) => p.summary).join("；") || "").slice(0, 200),
    });
    this.saveTask(rt, task);
    publish({ type: "task-update", projectDir: rt.projectDir, task: taskView(task) });

    if (changedFiles.length === 0) {
      // 8.4/V3：空改动 = 无进展
      sigGuard.recordNoProgress(sigLoopId, "修复后没有任何文件改动");
      total.recordNoProgress("L1-total", "修复后没有任何文件改动");
      const rec2 = sigGuard.get(sigLoopId);
      if ((rec2?.noProgressCount ?? 0) >= 2) {
        this.stopFixLoop(rt, task, "连续两次修复没有任何文件改动", "工人修复后项目没有任何文件改动（连续 2 次）", sig, problems.length);
        return false;
      }
      this.notice(rt, "warn", `工人修复后没有任何文件改动（无进展 ${rec2?.noProgressCount ?? 1}/2）。`, task.id);
    } else {
      this.notice(rt, "info", `第 ${task.fixAttempts.length} 次修复完成，改动 ${changedFiles.length} 个文件，重新验收中。`, task.id);
    }
    return true; // 回到 verifyAndFix 重新验收
  }

  /** M5 停止去向：暂停（verifying→waiting_user）+ 决策卡片（再试 / 修改标准 / 跳过 / 取消）。 */
  private stopFixLoop(rt: ProjectRuntime, task: Task, title: string, reason: string, sig: string, problemCount: number): void {
    this.notice(rt, "error", `${title}，任务暂停：${reason}`, task.id);
    this.pauseTask(rt, task, `${title}：${reason}`, {
      decision: "loop_stop",
      loopId: `L1-sig-${sig}`,
      kind: "L1 修复循环",
      reason,
      signature: sig,
      attempts: task.fixAttempts.length,
      problemCount,
      options: ["再试一次", "修改验收标准", "跳过该标准", "取消任务"],
    });
  }

  // ───────────── M8 重启恢复与运行期异常 ─────────────

  /** 打开项目时的恢复（M8）：上次中断的任务自动重新入队；恢复满 2 次不再自动恢复。 */
  recoverOnBoot(rt: ProjectRuntime): void {
    let recovered = 0;
    for (const t of rt.store.list()) {
      if (SLOT_STATUSES.includes(t.status)) {
        t.recoverCount += 1;
        t.lastRecoverAt = now();
        if (t.recoverCount >= 2) {
          rt.store.forceStatus(t, "paused", `重启恢复第 ${t.recoverCount} 次后再次异常退出，停止自动恢复（M8）`);
          t.pausedReason = "重启后反复异常退出，已停止自动恢复（M8）";
          rt.store.saveTask(t);
          this.openCard(rt, "decision", "任务反复异常退出", {
            decision: "resume_task",
            taskId: t.id,
            title: t.title,
            reason: t.pausedReason,
            options: ["继续执行", "保持暂停", "取消任务"],
          }, t.id);
          this.notice(rt, "error", `任务「${t.title}」多次恢复后仍异常退出，已暂停（M8）。`, t.id);
        } else {
          rt.store.forceStatus(t, "queued", `服务重启，自动恢复（第 ${t.recoverCount} 次，M8）`);
          rt.store.requeueFront(t.id); // 恢复的任务放队首（需求 6.2）
          recovered += 1;
        }
      } else if (t.status === "waiting_user") {
        // 决策卡片不落盘，重启后重新给出决策入口
        this.openCard(rt, "decision", "任务等待你的决定", {
          decision: "resume_task",
          taskId: t.id,
          title: t.title,
          reason: t.pausedReason ?? "等待使用者决定",
          options: ["继续执行", "保持暂停", "取消任务"],
        }, t.id);
      }
    }
    if (recovered > 0) {
      this.notice(rt, "warn", `从状态文件恢复了 ${recovered} 个未完成任务（已放队首）。`);
    }
    this.pumpQueue(rt);
  }

  /** 运行期异常（M8：恢复后 60 秒内再崩 → 计数，2 次即停；普通异常 → 暂停+卡片）。 */
  private async onRuntimeCrash(rt: ProjectRuntime, task: Task, e: any): Promise<void> {
    const msg = String(e?.message ?? e);
    warn("orchestrator", `任务执行异常：${msg}`, task.id);
    if (rt.stopWorker.has(task.id)) {
      try {
        rt.stopWorker.get(task.id)?.();
      } catch {
        /* ignore */
      }
    }
    const recoveredAt = task.lastRecoverAt ? new Date(task.lastRecoverAt).getTime() : 0;
    const within60s = recoveredAt > 0 && Date.now() - recoveredAt < 60_000;
    if (within60s) {
      task.recoverCount += 1;
      if (task.recoverCount >= 2) {
        rt.store.forceStatus(task, "paused", `恢复后 60 秒内再次异常退出（第 ${task.recoverCount} 次），停止自动恢复（M8）`);
        task.pausedReason = "反复异常退出，已停止自动恢复（M8）";
        this.saveTask(rt, task);
        this.openCard(rt, "decision", "任务反复异常退出", {
          decision: "resume_task",
          taskId: task.id,
          reason: task.pausedReason,
          options: ["继续执行", "保持暂停", "取消任务"],
        }, task.id);
        this.notice(rt, "error", `任务「${task.title}」反复异常退出，已暂停（M8）。`, task.id);
        return;
      }
      this.notice(rt, "warn", `任务异常（${msg}），自动恢复重试（第 ${task.recoverCount} 次）。`, task.id);
      rt.store.forceStatus(task, "queued", `异常自动恢复（第 ${task.recoverCount} 次，M8）`);
      rt.store.requeueFront(task.id);
      this.saveTask(rt, task);
      this.pumpQueue(rt);
      return;
    }
    this.pauseTask(rt, task, `执行异常：${msg}`, {
      decision: "resume_task",
      taskId: task.id,
      reason: msg,
      options: ["继续执行", "保持暂停", "取消任务"],
    });
  }

  // ───────────── 任务命令（7.3 单写者；供 server 调用） ─────────────

  /** 暂停：停工人（停 10s → 杀树）；verifying → waiting_user，其余 → paused（6.1）。 */
  pauseTask(rt: ProjectRuntime, task: Task, reason: string, card?: any): void {
    try {
      rt.stopWorker.get(task.id)?.();
    } catch {
      /* ignore */
    }
    const to: TaskStatus = task.status === "verifying" ? "waiting_user" : "paused";
    this.setStatus(rt, task, to, reason);
    task.pausedReason = reason;
    this.saveTask(rt, task);
    if (card) this.openCard(rt, "decision", cardTitleOf(card), card, task.id);
  }

  /** 恢复：paused → queued 并放队首（6.2）。 */
  resumeTask(rt: ProjectRuntime, task: Task): { ok: boolean; detail?: string } {
    if (task.status !== "paused") return { ok: false, detail: `任务当前为「${TASK_STATUS_LABEL[task.status]}」，无需恢复` };
    this.setStatus(rt, task, "queued", "使用者恢复任务");
    rt.store.requeueFront(task.id);
    task.pausedReason = undefined;
    this.saveTask(rt, task);
    this.notice(rt, "info", `任务「${task.title}」已恢复，重新入队。`, task.id);
    this.pumpQueue(rt);
    return { ok: true };
  }

  /** 取消：任意非终态 → cancelled（终态），停工人，触发记忆整理（9.5）。 */
  cancelTask(rt: ProjectRuntime, task: Task): { ok: boolean; detail?: string } {
    if (["passed", "failed", "cancelled"].includes(task.status)) return { ok: false, detail: "任务已是终态" };
    try {
      rt.stopWorker.get(task.id)?.();
    } catch {
      /* ignore */
    }
    this.setStatus(rt, task, "cancelled", "使用者取消任务");
    this.notice(rt, "warn", `任务「${task.title}」已取消。`, task.id);
    this.consolidateMemory(rt, task, `任务「${task.title}」被取消。需求：${task.requirement.slice(0, 200)}`);
    this.pumpQueue(rt);
    return { ok: true };
  }

  /** 移除：仅非运行态；软删除到 trash 保留 7 天（6.4）。 */
  removeTask(rt: ProjectRuntime, task: Task): { ok: boolean; detail?: string } {
    if (SLOT_STATUSES.includes(task.status)) return { ok: false, detail: "运行中的任务请先取消再移除" };
    const dir = projectTrashDir(rt.projectDir);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.renameSync(rt.store.fileOf(task.id), path.join(dir, `${task.id}-${Date.now()}.json`));
    } catch (e: any) {
      return { ok: false, detail: `移入回收站失败：${e.message}` };
    }
    rt.store.forget(task.id);
    this.notice(rt, "info", `任务「${task.title}」已移除（回收站保留 7 天）。`, task.id);
    return { ok: true };
  }

  /** 回滚到任务开始前（6.3）：恢复 snapshotRef 指向的快照。 */
  async rollbackTask(rt: ProjectRuntime, task: Task): Promise<{ ok: boolean; detail: string }> {
    if (SLOT_STATUSES.includes(task.status)) return { ok: false, detail: "任务执行中，请先暂停或取消再回滚" };
    const ref = task.snapshotRef ?? `refs/dispatch/snapshots/${task.id}`;
    const restore = await runInProject(rt.projectDir, `git restore --source=${ref} --worktree --staged -- .`, 120, gitIdentity());
    if (restore.exitCode !== 0) return { ok: false, detail: `回滚失败：${restore.output.slice(-300)}` };
    // 删除快照后才新增的未跟踪文件（.dispatch 除外）
    const untracked = await runInProject(rt.projectDir, "git ls-files --others --exclude-standard");
    const snapFiles = await runInProject(rt.projectDir, `git ls-tree -r --name-only ${ref}`);
    const snapSet = new Set(snapFiles.output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    let removed = 0;
    for (const rel of untracked.output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      if (rel.startsWith(".dispatch")) continue;
      if (snapSet.has(rel)) continue;
      try {
        fs.rmSync(safeJoin(rt.projectDir, rel), { force: true });
        removed += 1;
      } catch {
        /* 单个失败不阻断 */
      }
    }
    this.notice(rt, "info", `已回滚任务「${task.title}」到开始前快照（删除了 ${removed} 个新增文件）。`, task.id);
    return { ok: true, detail: "已回滚到任务开始前快照" };
  }

  /** git 快照（6.3）：write-tree + commit-tree，只写独立引用，不污染使用者分支。 */
  private async snapshotTask(rt: ProjectRuntime, task: Task): Promise<void> {
    if (!fs.existsSync(path.join(rt.projectDir, ".git"))) {
      const init = await runInProject(rt.projectDir, "git init");
      if (init.exitCode === 0) {
        (rt as ProjectRuntime).ensureGitExclude();
        this.notice(rt, "info", "项目目录不是 git 仓库，已自动 git init 并生成任务快照。", task.id);
      }
    }
    await runInProject(rt.projectDir, "git add -A");
    const tree = await runInProject(rt.projectDir, "git write-tree");
    if (tree.exitCode !== 0) {
      warn("orchestrator", `git write-tree 失败：${tree.output}`, task.id);
      return;
    }
    const commit = await runInProject(
      rt.projectDir,
      `git commit-tree ${tree.output.trim()} -m "dispatch-snapshot: ${task.id} ${task.title.replace(/"/g, "'")}"`,
      60,
      gitIdentity()
    );
    if (commit.exitCode !== 0) {
      warn("orchestrator", `git commit-tree 失败：${commit.output}`, task.id);
      return;
    }
    const ref = `refs/dispatch/snapshots/${task.id}`;
    await runInProject(rt.projectDir, `git update-ref ${ref} ${commit.output.trim()}`);
    task.snapshotRef = commit.output.trim();
    this.saveTask(rt, task);
    info("orchestrator", `任务快照完成：${commit.output.trim().slice(0, 8)}`, task.id);
  }

  /** 当前工作区树（write-tree，用于修复前后对比 changedFiles，8.4）。 */
  private async gitTree(rt: ProjectRuntime, task: Task): Promise<string | null> {
    await runInProject(rt.projectDir, "git add -A");
    const tree = await runInProject(rt.projectDir, "git write-tree");
    if (tree.exitCode !== 0) {
      warn("orchestrator", `gitTree 失败：${tree.output.slice(-200)}`, task.id);
      return null;
    }
    void task;
    return tree.output.trim() || null;
  }

  private async changedFiles(rt: ProjectRuntime, t1: string, t2: string): Promise<string[]> {
    const diff = await runInProject(rt.projectDir, `git diff --name-only ${t1} ${t2}`);
    if (diff.exitCode !== 0) return [];
    return diff.output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  // ───────────── 决策卡片处理 ─────────────

  /** 使用者对决策卡片做出选择（按钮）或自由回答（文本）。 */
  async decide(dir: string, cardId: string, choice: string): Promise<void> {
    const rt = this.ensureProject(dir);
    const card = rt.cards.get(cardId);
    if (!card || card.status !== "open") return;
    this.settleCard(rt, cardId, "answered", choice);
    const p = card.payload ?? {};
    const task = p.taskId ? rt.store.get(p.taskId) : undefined;
    switch (p.decision) {
      case "ask_permission": {
        if (!task) return;
        const note = choice === "批准并继续" ? `使用者已明确批准该操作（${p.command}），请继续。` : `使用者拒绝了该操作（${p.command}），请换一种方案完成目标。`;
        await this.resumeFromWaiting(rt, task, note);
        return;
      }
      case "worker_question": {
        if (!task) return;
        const note = `使用者回答了你的问题「${p.question}」：${choice}。请继续完成当前工作。`;
        await this.resumeFromWaiting(rt, task, note);
        return;
      }
      case "loop_stop": {
        if (!task) return;
        if (choice === "再试一次" || choice === "重试一次") {
          this.resetFixLoops(task);
          await this.resumeFromWaiting(rt, task, undefined, "verifying");
          return;
        }
        if (choice === "修改验收标准") {
          this.notice(rt, "info", "请在聊天中描述要修改的验收标准；改好后点「已改好，重新验收」。", task.id);
          this.openCard(rt, "decision", "等待你修改验收标准", {
            decision: "loop_stop_await_criteria",
            taskId: task.id,
            options: ["已改好，重新验收", "取消任务"],
          }, task.id);
          return;
        }
        if (choice === "跳过该标准") {
          await this.skipCriteria(rt, task, p.problemCriterionIds ?? []);
          return;
        }
        if (choice === "取消任务") {
          this.cancelTask(rt, task);
        }
        return;
      }
      case "loop_stop_await_criteria": {
        if (!task) return;
        if (choice === "已改好，重新验收") {
          await this.resumeFromWaiting(rt, task, undefined, "verifying");
        } else {
          this.cancelTask(rt, task);
        }
        return;
      }
      case "worker_unavailable": {
        if (!task) return;
        if (choice === "重试") {
          delete task.loops["L6"];
          this.saveTask(rt, task);
          await this.resumeFromWaiting(rt, task);
        } else {
          this.cancelTask(rt, task);
        }
        return;
      }
      case "dispatch_blocked": {
        if (!task) return;
        if (choice === "再试一次" || choice === "重新验收") {
          await this.resumeFromWaiting(rt, task, undefined, task.steps.length > task.currentStepIndex ? "running" : "verifying");
        } else {
          this.cancelTask(rt, task);
        }
        return;
      }
      case "control_confirm": {
        if (!task) return;
        if (choice !== "确认执行") return;
        if (p.action === "pause") this.pauseTask(rt, task, "使用者通过聊天指令暂停");
        else if (p.action === "cancel") this.cancelTask(rt, task);
        else if (p.action === "resume") this.resumeTask(rt, task);
        return;
      }
      case "criteria_invalid": {
        if (choice !== "重试生成") return;
        // 使用者明确要求重试 → 清空该需求的 L2 预算，重新走需求生成
        this.l2Budgets.delete(crypto.createHash("sha1").update(p.requirement ?? "").digest("hex").slice(0, 12));
        try {
          const raw = await callBrain({
            messages: criteriaRegenPrompt(p.requirement ?? "", [], p.errors ?? []),
          });
          const reply = parseBrainReply(raw);
          if (reply.type === "requirement") await this.presentRequirement(rt, reply);
          else this.notice(rt, "error", "大脑没有返回有效的需求 JSON，请换一种说法重试。");
        } catch (e: any) {
          this.notice(rt, "error", `重新生成失败：${e?.message ?? e}`);
        }
        return;
      }
      case "resume_task": {
        if (!task) return;
        if (choice === "继续执行" || choice === "重新验收") {
          if (task.status === "paused") {
            this.resumeTask(rt, task);
          } else {
            await this.resumeFromWaiting(rt, task, undefined, choice === "重新验收" ? "verifying" : "running");
          }
        } else if (choice === "取消任务") {
          this.cancelTask(rt, task);
        }
        return;
      }
      case "hard_block": {
        if (!task) return;
        if (choice === "取消任务") this.cancelTask(rt, task);
        return;
      }
      case "install_tool": {
        if (choice === "安装") {
          const { startFix } = await import("./envcheck/check");
          const h = startFix(p.tool);
          void h.promise.catch(() => {});
        }
        return;
      }
      default:
        this.notice(rt, "info", `已收到你的选择「${choice}」。`);
    }
  }

  /** 从 waiting_user 恢复执行：带备注重新进入主循环或直接重验。 */
  private async resumeFromWaiting(rt: ProjectRuntime, task: Task, note?: string, to: "running" | "verifying" = "running"): Promise<void> {
    if (note) rt.stepNotes.set(task.id, note);
    task.pausedReason = undefined;
    this.saveTask(rt, task);
    if (to === "verifying" || task.currentStepIndex >= task.steps.length) {
      this.setStatus(rt, task, "verifying", "使用者决策后重新验收");
      void this.verifyAndFixSafe(rt, task);
    } else {
      this.setStatus(rt, task, "running", "使用者决策后继续执行");
      void this.runTask(rt, task);
    }
  }

  private async verifyAndFixSafe(rt: ProjectRuntime, task: Task): Promise<void> {
    try {
      await this.verifyAndFix(rt, task);
    } catch (e: any) {
      await this.onRuntimeCrash(rt, task, e);
    } finally {
      this.pumpQueue(rt);
    }
  }

  /** 跳过指定标准（M5 卡片选项）：从 criteria 中移除后重新验收。 */
  private async skipCriteria(rt: ProjectRuntime, task: Task, criterionIds: string[]): Promise<void> {
    const ids = new Set(criterionIds);
    const removed = task.criteria.filter((c) => ids.has(c.id));
    task.criteria = task.criteria.filter((c) => !ids.has(c.id));
    for (const id of ids) delete task.criteriaStatus[id];
    this.saveTask(rt, task);
    this.notice(rt, "warn", `已跳过 ${removed.length} 条验收标准：${removed.map((c) => c.text).join("；") || "（无）"}`, task.id);
    if (task.criteria.length === 0) {
      this.setStatus(rt, task, "passed", "全部标准被跳过，视为完成");
      this.consolidateMemory(rt, task, `任务「${task.title}」的全部验收标准被使用者跳过后完成。`);
      return;
    }
    await this.resumeFromWaiting(rt, task, undefined, "verifying");
  }

  /** 「再试一次」：重置 L1 循环预算（使用者明确授权的重试，M5）。 */
  private resetFixLoops(task: Task): void {
    for (const id of Object.keys(task.loops)) {
      if (id.startsWith("L1") || id === "L3") delete task.loops[id];
    }
  }

  // ───────────── L13 记忆整理 ─────────────

  /** 任务终态触发一次记忆整理（9.5/L13）：预算落盘（loops.L13），整理产出不再触发整理。 */
  private consolidateMemory(rt: ProjectRuntime, task: Task, taskSummary: string): void {
    const guard = this.guardFor(rt, task, "L13", "L13", 1);
    const d = guard.permit("L13");
    if (!d.allowed) return; // 每个任务只整理一次（重启也不重复）
    void (async () => {
      try {
        const current = memory.readRaw("project", 3000);
        const raw = await callBrain({ messages: memoryConsolidationPrompt(current, taskSummary) });
        const reply = parseBrainReply(raw);
        if (reply.type !== "memory_consolidation") return;
        guard.record("L13", signatureOf("memory", "consolidation", taskSummary.slice(0, 100)));
        const r = memory.applyConsolidation("project", { add: reply.add, update: reply.update, delete: reply.delete }, task.id);
        if (!r.ok) warn("orchestrator", `记忆整理应用失败：${r.error}`, task.id);
        else {
          publish({ type: "memory-update", scope: "project" });
          info("orchestrator", `记忆整理完成（L13）：新增 ${reply.add.length} 条`, task.id);
        }
      } catch (e: any) {
        warn("orchestrator", `记忆整理失败（跳过）：${e?.message ?? e}`, task.id);
        guard.record("L13", signatureOf("memory", "consolidation", "error"));
      }
    })();
  }

  // ───────────── 看门狗（M6） ─────────────

  getWatchdogUsage(): WatchdogTaskUsage[] {
    const out: WatchdogTaskUsage[] = [];
    for (const rt of this.runtimes.values()) {
      for (const t of rt.store.list()) {
        if (!SLOT_STATUSES.includes(t.status)) continue;
        out.push({
          taskId: t.id,
          projectDir: rt.projectDir,
          title: t.title,
          startedAt: rt.taskStartedAt.get(t.id) ?? t.statusHistory.filter((h) => h.status === "running").slice(-1)[0]?.ts ?? t.updatedAt,
          workerCalls: t.counters.workerCalls,
          brainCalls: t.counters.brainCalls,
          lastActivityAt: t.counters.lastActivityAt,
        });
      }
    }
    return out;
  }

  onWatchdogTrigger(trigger: WatchdogTrigger): void {
    for (const rt of this.runtimes.values()) {
      const task = rt.store.get(trigger.taskId);
      if (!task || !SLOT_STATUSES.includes(task.status)) continue;
      this.notice(rt, "error", `看门狗触发，任务已暂停：${trigger.detail}`, task.id);
      this.pauseTask(rt, task, `看门狗：${trigger.reason}`, {
        decision: "resume_task",
        taskId: task.id,
        title: task.title,
        reason: trigger.detail,
        options: ["继续执行", "保持暂停", "取消任务"],
      });
      return;
    }
  }

  // ───────────── 工人提示词 ─────────────

  private workerConventions(): string {
    return [
      `约定：`,
      `- 若你判断问题不在项目文件而在调度中心一侧（例如验收标准本身有误、环境由调度中心负责），请在最终回复中单独输出一行，以 DISPATCH_BLOCKED: 开头并简述原因。`,
      `- 若你需要向使用者确认信息，请在最终回复的最后单独输出一行，以 ${WORKER_QUESTION_PREFIX} 开头写出问题。`,
    ].join("\n");
  }

  private workerStepPrompt(rt: ProjectRuntime, task: Task, step: Step): string {
    return [
      `你是「调度中心」指挥的编码工人，正在项目目录 ${rt.projectDir} 中工作。`,
      `任务：${task.title}`,
      `项目需求：${task.requirement}`,
      `请完成当前步骤：${step.title}`,
      `具体指令：${step.instruction}`,
      `硬性要求：`,
      `1. 只能在当前项目目录内创建或修改文件，绝不触碰调度中心程序目录或系统目录；`,
      `2. 不得修改 .dispatch 目录；`,
      `3. 完成后用不超过三句话总结你做了什么（不要宣称"任务已完成"，完成与否由自动验收判定）。`,
      this.workerConventions(),
    ].join("\n");
  }

  /** 修复提示词（8.2 必备内容：原文/期望/实际/证据/历史尝试/禁令）。 */
  private workerFixPrompt(rt: ProjectRuntime, task: Task, problems: { criterionId: string; summary: string; expected: string; actual: string; evidence?: string }[], attemptNo: number): string {
    const history = task.fixAttempts.length
      ? task.fixAttempts.map((f) => `- 第 ${f.seq} 次：签名 ${f.signature.slice(0, 8)}，改动 ${f.changedFiles.length} 个文件${f.summary ? `（${f.summary}）` : ""}`).join("\n")
      : "（无）";
    const problemText = problems
      .map((p, i) => {
        const c = task.criteria.find((x) => x.id === p.criterionId);
        return [
          `${i + 1}. 标准 ${p.criterionId}：${c?.text ?? p.summary}`,
          `   期望：${p.expected}`,
          `   实际：${p.actual.split("\n")[0]}`,
          p.evidence ? `   证据文件：data/screenshots/${p.evidence}（界面可查看截图）` : "",
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n");
    return [
      `你是「调度中心」指挥的编码工人，正在项目目录 ${rt.projectDir} 中工作。`,
      `任务：${task.title}`,
      `项目需求：${task.requirement}`,
      `自动验收发现以下项目缺陷（第 ${attemptNo} 次修复请求），请逐一修复：`,
      problemText,
      `此前修复尝试（避免重复同样的改法）：`,
      history,
      `硬性要求：`,
      `1. 只修复与上述问题相关的代码；`,
      `2. 只能在当前项目目录内修改文件；不得修改 .dispatch 目录；不得试图修改验收标准本身；`,
      `3. 修复完成后用不超过三句话说明改了什么。`,
      this.workerConventions(),
    ].join("\n");
  }
}

function cardTitleOf(card: any): string {
  switch (card?.decision) {
    case "hard_block": return "危险操作被重复拦截";
    case "worker_unavailable": return "工人不可用";
    case "loop_stop": return "修复循环停止";
    case "resume_task": return "任务已暂停";
    case "dispatch_blocked": return "工人回报调度侧问题";
    case "ask_permission": return "工人请求权限";
    case "worker_question": return "工人有一个问题";
    default: return "需要你的决定";
  }
}

function gitIdentity(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: "dispatch-center",
    GIT_AUTHOR_EMAIL: "dispatch@local",
    GIT_COMMITTER_NAME: "dispatch-center",
    GIT_COMMITTER_EMAIL: "dispatch@local",
  };
}

export const orchestrator = new Orchestrator();

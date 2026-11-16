/**
 * 编排器：调度中心的主循环（需求 1/6.1/6.2/6.6）。
 *
 * 大流程：
 *   使用者说需求 → 大脑澄清(最多一个问题) → 大脑生成「需求+验收标准」→ 需求确认卡片
 *   → 使用者确认 → 大脑拆解步骤 → 逐步骤驱动工人(codex)执行
 *   → 全部步骤完成后自动验收(Playwright/命令/文件)
 *   → 验收不通过 → 结构化报错发给工人修复 → 重新验收
 *   → 同一错误连续修复超过上限(默认3次) → 暂停 + 决策卡片
 *   → 全部验收标准通过 → 任务完成（工人自己说"做完了"不算，需求 6.5）
 *
 * 每个任务开始前自动做 git 快照（需求 6.4 安全网），出错可一键回滚。
 * 任务状态全部经 TaskStore 落盘到 <项目目录>/.dispatch/state.json（需求 6.2）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { TaskStore, Task, Criterion, Step, TASK_STATUS_LABEL } from "./tasks/store";
import { getAdapter, registerAdapter, WorkerAdapter } from "./worker/codex";
import { WorkerEvent } from "./worker/types";
import { runAcceptance, StructuredProblem } from "./acceptance/runner";
import { callBrain, parseBrainReply, BrainReply, BRAIN_SYSTEM_PROMPT } from "./brain/brain";
import { Card, publish, newCardId } from "./events";
import { getConfig, loadProjects, ProjectEntry } from "./config";
import { PolicyLedger, classifyCommand } from "./policy/permissions";
import { info, warn } from "./logger";
import { dataDir, safeJoin } from "./util/paths";

/** 测试可通过 registerAdapter 注入桩工人；生产用 codex。 */
export function injectWorker(adapter: WorkerAdapter): void {
  registerAdapter(adapter);
}

function errKeyOf(problems: StructuredProblem[]): string {
  const norm = problems
    .map((p) => `${p.source}|${(p.message || "").replace(/\d+/g, "#").slice(0, 120)}|${p.statusCode ?? ""}`)
    .sort()
    .join("\n");
  return crypto.createHash("sha1").update(norm).digest("hex").slice(0, 12);
}

export class Orchestrator {
  store = new TaskStore();
  ledger = new PolicyLedger();
  projectDir = "";
  private history: { role: "user" | "assistant"; content: string }[] = [];
  private cards = new Map<string, Card>();
  private running = false;
  private currentTaskId: string | null = null;
  private taskStartedAt = 0;
  private abort: AbortController | null = null;
  private stopWorker: (() => void) | null = null;

  get isRunning(): boolean {
    return this.running;
  }

  // ───────────────────────── 项目与会话 ─────────────────────────

  openProject(dir: string): void {
    this.projectDir = path.resolve(dir);
    fs.mkdirSync(this.projectDir, { recursive: true });
    this.store.load(this.projectDir);
    this.history = this.loadHistory();
    info("orchestrator", `打开项目: ${this.projectDir}，载入 ${this.store.current.tasks.length} 个任务`);
  }

  get currentProject(): string {
    return this.projectDir;
  }

  private chatFile(): string {
    const h = crypto.createHash("sha1").update(this.projectDir).digest("hex").slice(0, 10);
    return path.join(dataDir(), `chat-${h}.json`);
  }

  private loadHistory(): { role: "user" | "assistant"; content: string }[] {
    try {
      return JSON.parse(fs.readFileSync(this.chatFile(), "utf8"));
    } catch {
      return [];
    }
  }

  private appendHistory(role: "user" | "assistant", content: string): void {
    this.history.push({ role, content });
    if (this.history.length > 60) this.history = this.history.slice(-60);
    try {
      fs.mkdirSync(dataDir(), { recursive: true });
      fs.writeFileSync(this.chatFile(), JSON.stringify(this.history, null, 2), "utf8");
    } catch {
      /* 持久化失败不阻断 */
    }
  }

  // ───────────────────────── 卡片 ─────────────────────────

  private openCard(kind: Card["kind"], title: string, payload: any): Card {
    const card: Card = { id: newCardId(), kind, title, payload, status: "open", createdAt: new Date().toISOString() };
    this.cards.set(card.id, card);
    publish({ type: "card", card });
    return card;
  }

  private settleCard(id: string, status: Card["status"], answer?: any): Card | undefined {
    const card = this.cards.get(id);
    if (!card) return undefined;
    card.status = status;
    if (answer !== undefined) (card as any).answer = answer;
    publish({ type: "card-update", card });
    return card;
  }

  getOpenCards(): Card[] {
    return [...this.cards.values()].filter((c) => c.status === "open");
  }

  /** 供 API 层（安装确认等场景）直接开一张决策卡片。 */
  openCardPublic(kind: Card["kind"], title: string, payload: any): Card {
    return this.openCard(kind, title, payload);
  }

  // ───────────────────────── 对话入口 ─────────────────────────

  /** 使用者发来一条消息：流式转发大脑回复；返回结束后由 API 统一收尾。 */
  async handleUserMessage(text: string, onDelta: (t: string) => void): Promise<void> {
    this.appendHistory("user", text);
    const sys = this.systemPrompt();
    const messages = [
      { role: "system" as const, content: sys },
      ...this.history.slice(-20).map((m) => ({ role: m.role, content: m.content })),
    ];
    this.abort = new AbortController();
    let full = "";
    let lastSent = 0;
    try {
      full = await callBrain({
        messages,
        signal: this.abort.signal,
        onDelta: (t) => {
          // 大脑按协议输出 JSON；text 字段外的协议骨架不外发。
          // 增量里属于 text 值的新增部分才推给前端。
          full += t;
          const p = parseProgressive(full);
          if (p.text.length > lastSent) {
            onDelta(p.text.slice(lastSent));
            lastSent = p.text.length;
          }
        },
      });
    } catch (e: any) {
      publish({ type: "notice", level: "error", text: `调用大脑失败: ${e.message}` });
      this.appendHistory("assistant", `（调用大脑失败: ${e.message}）`);
      throw e;
    }
    let reply = parseBrainReply(full);
    // 模型偶尔跳过需求确认直接输出 plan：纠正重问一次，要求输出 requirement
    if (reply.type === "plan") {
      const corrective = await callBrain({
        messages: [
          ...messages,
          { role: "assistant" as const, content: full },
          {
            role: "user" as const,
            content:
              "你输出了 plan，但使用者还没有确认需求。请重新输出 requirement 类型的 JSON（先复述需求，再给出可自动检查的验收标准 criteria），不要输出 plan。",
          },
        ],
      });
      reply = parseBrainReply(corrective);
      if (reply.type === "requirement") {
        this.appendHistory("assistant", reply.requirement);
      }
    }
    // 模型偶尔省略顶层 text 字段：流式期间没有任何输出时，用解析结果补一段说明
    if (lastSent === 0) {
      const fallback =
        reply.type === "requirement"
          ? `我已整理好需求与验收标准，请查看下方卡片确认。`
          : reply.text || "（大脑没有返回内容，请检查设置中心的大脑配置）";
      onDelta(fallback);
    }
    this.appendHistory("assistant", reply.type === "requirement" ? reply.requirement : reply.text);
    switch (reply.type) {
      case "requirement": {
        if (reply.criteria.length === 0) {
          onDelta("\n\n这份需求暂时给不出可自动检查的验收标准，请补充一些可验证的目标（比如页面地址、需要生成的文件、要跑通的命令）。");
          break;
        }
        this.openCard("requirement", "需求确认", {
          requirement: reply.requirement,
          criteria: reply.criteria,
        });
        break;
      }
      case "clarify":
      case "chat":
      case "plan":
        break; // text 已流式输出；plan 已纠正重问
    }
  }

  /** 构造大脑系统提示（含项目上下文与执行状态）。 */
  private systemPrompt(): string {
    const cfg = getConfig();
    const tasks = this.projectDir ? this.store.current.tasks : [];
    const last = tasks.length ? tasks[tasks.length - 1] : undefined;
    let stateLine = "（当前没有项目或没有任务）";
    if (last) {
      stateLine = `当前项目: ${this.projectDir}；最新任务「${last.title}」状态=${TASK_STATUS_LABEL[last.status]}，步骤进度=${last.currentStepIndex}/${last.steps.length}，验收状态=${Object.entries(last.criteriaStatus)
        .map(([k, v]) => `${k}:${v.status}`)
        .join(", ") || "未开始"}。`;
    }
    const running = this.running
      ? "注意：任务正在执行中，请用 chat 类型回复进展或回答问题，不要输出 requirement/plan。"
      : "注意：当前空闲，可以接收新需求。";
    return `${BRAIN_SYSTEM_PROMPT}\n\n[运行环境]\n大脑模型=${cfg.brain.model}；权限模式=${cfg.permissionMode === "yolo" ? "YOLO(自动批准)" : "分级询问"}。\n[项目状态]\n${stateLine}\n${running}`;
  }

  // ───────────────────────── 需求确认 → 执行 ─────────────────────────

  /** 使用者点击需求确认卡片。 */
  async confirmRequirement(cardId: string): Promise<void> {
    const card = this.settleCard(cardId, "confirmed");
    if (!card || card.kind !== "requirement") return;
    const { requirement, criteria } = card.payload;
    await this.startTask(requirement, criteria);
  }

  /** 创建任务并进入执行主循环。 */
  async startTask(requirement: string, criteriaDrafts: any[]): Promise<Task> {
    if (this.running) throw new Error("已有任务在执行中（第一期不支持多任务并行）");
    const criteria: Criterion[] = criteriaDrafts.map((c, i) => ({
      id: String(c.id ?? `C${i + 1}`),
      text: String(c.text ?? ""),
      kind: c.kind,
      url: c.url,
      path: c.path,
      command: c.command,
    }));
    const task = this.store.createTask(requirement.slice(0, 60) || "新任务", requirement, criteria);
    // 大脑拆解步骤
    const planReply = await this.planWithBrain(requirement, criteria);
    const limit = getConfig().limits.maxStepsPerTask;
    let steps: Step[] = planReply.steps.map((s, i) => ({
      id: String(s.id ?? `S${i + 1}`),
      title: String(s.title ?? `步骤${i + 1}`),
      instruction: String(s.instruction ?? s.title ?? ""),
      status: "todo" as const,
    }));
    if (steps.length > limit) {
      publish({ type: "notice", level: "warn", text: `大脑给出的步骤数 ${steps.length} 超过上限 ${limit}，已截断，可在设置中心调整上限。` });
      steps = steps.slice(0, limit);
    }
    if (steps.length === 0) {
      steps = [{ id: "S1", title: "实现需求", instruction: requirement, status: "todo" }];
    }
    this.store.setSteps(task, steps);
    await this.snapshot("任务开始前");
    publish({ type: "task-update", projectDir: this.projectDir, task: taskSnapshot(task) });
    // 异步启动主循环（不阻塞确认请求）
    void this.runTaskLoop(task);
    return task;
  }

  private async planWithBrain(requirement: string, criteria: Criterion[]): Promise<Extract<BrainReply, { type: "plan" }>> {
    const messages = [
      { role: "system" as const, content: this.systemPrompt() },
      {
        role: "user" as const,
        content: `使用者已确认以下需求，请输出 plan 类型 JSON，把任务拆解为给工人的步骤：\n【需求】${requirement}\n【验收标准】${JSON.stringify(criteria)}`,
      },
    ];
    const full = await callBrain({ messages });
    const reply = parseBrainReply(full);
    if (reply.type !== "plan") {
      // 大脑没按协议出计划：退化为单步执行
      warn("orchestrator", `大脑未返回 plan（返回 ${reply.type}），退化为单步执行`);
      return { type: "plan", text: "", steps: [{ id: "S1", title: "实现需求", instruction: requirement }] };
    }
    return reply;
  }

  // ───────────────────────── 主循环 ─────────────────────────

  private workerPromptForStep(task: Task, step: Step): string {
    return [
      `你是「调度中心」指挥的编码工人，正在项目目录 ${this.projectDir} 中工作。`,
      `项目需求：${task.requirement}`,
      `请完成当前步骤：${step.title}`,
      `具体指令：${step.instruction}`,
      `硬性要求：`,
      `1. 只能在当前项目目录内创建或修改文件，绝不触碰调度中心程序目录或系统目录；`,
      `2. 网页项目生成静态文件（入口 index.html）即可，无需启动开发服务器，验收时调度中心会用内置预览打开它；`,
      `3. 完成后用不超过三句话总结你做了什么（不要宣称"任务已完成"，完成与否由自动验收判定）。`,
    ].join("\n");
  }

  private workerPromptForFix(task: Task, problems: StructuredProblem[], attempt: number): string {
    return [
      `你是「调度中心」指挥的编码工人，正在项目目录 ${this.projectDir} 中工作。`,
      `项目需求：${task.requirement}`,
      `自动验收发现以下问题（第 ${attempt} 次修复请求），请逐一修复：`,
      JSON.stringify(problems, null, 2),
      `硬性要求：`,
      `1. 只修复与上述问题相关的代码；`,
      `2. 只能在当前项目目录内修改文件；`,
      `3. 修复完成后用不超过三句话说明改了什么。`,
    ].join("\n");
  }

  /** 主循环：顺序执行步骤 → 验收 → 修复循环。 */
  private async runTaskLoop(task: Task): Promise<void> {
    this.running = true;
    this.currentTaskId = task.id;
    this.taskStartedAt = Date.now();
    try {
      // 从第一个未通过的步骤继续（支持重启恢复）
      for (let si = task.currentStepIndex; si < task.steps.length; si++) {
        if (!this.enforceLimits(task)) return;
        const step = task.steps[si];
        task.currentStepIndex = si;
        this.store.updateStep(task, step.id, { status: "in_progress" });
        this.store.setStatus(task, "in_progress");
        publish({ type: "step-update", projectDir: this.projectDir, taskId: task.id, step });

        const ok = await this.runWorkerStep(task, step, this.workerPromptForStep(task, step));
        if (!ok) return; // runWorkerStep 内部已处理失败/暂停/卡片
        this.store.updateStep(task, step.id, { status: "passed", detail: "工人执行完成" });
        publish({ type: "step-update", projectDir: this.projectDir, taskId: task.id, step });

        // 同步任务引用（store.save 会重写文件，task 对象仍是同一引用）
        if (this.store.getTask(task.id) !== task) return;
      }

      // 全部步骤完成 → 验收（工人说完成不算，验收通过才算，需求 6.5）
      await this.acceptAndFix(task);
    } catch (e: any) {
      warn("orchestrator", `任务循环异常: ${e.message}`);
      this.store.forceStatus(task, "failed");
      this.store.setConclusion(task, `执行异常: ${e.message}`);
      publish({ type: "task-update", projectDir: this.projectDir, task: taskSnapshot(task) });
      publish({ type: "notice", level: "error", text: `任务执行异常：${e.message}` });
    } finally {
      this.running = false;
      this.currentTaskId = null;
      publish({ type: "task-update", projectDir: this.projectDir, task: taskSnapshot(task) });
    }
  }

  /** 运行一次工人步骤；返回 false 表示该步骤已转入等待/失败/暂停，主循环应退出。 */
  private async runWorkerStep(task: Task, step: Step, prompt: string, resumeThreadId?: string): Promise<boolean> {
    const cfg = getConfig();
    const adapter = getAdapter(cfg.worker.kind);
    return new Promise<boolean>((resolve) => {
      const handle = adapter.run({
        projectDir: this.projectDir,
        prompt,
        mode: cfg.permissionMode,
        resumeThreadId,
        onEvent: (e: WorkerEvent) => this.onWorkerEvent(task, step, e, resolve),
      });
      this.stopWorker = handle.stop;
      handle.result
        .then(async (res) => {
          this.stopWorker = null;
          if (res.threadId) task.threadId = res.threadId;
          this.store.save();
          if (res.ok) {
            resolve(true);
            return;
          }
          if (res.error) {
            // 工人自身失败（启动失败/认证失败等）
            this.store.updateStep(task, step.id, { status: "failed", detail: res.error });
            this.store.setStatus(task, "failed");
            this.store.setConclusion(task, `工人执行失败: ${res.error}`);
            publish({ type: "notice", level: "error", text: `工人执行失败：${res.error}` });
            this.openCard("decision", "工人执行失败", {
              decision: "worker_failed",
              taskId: task.id,
              stepId: step.id,
              prompt,
              error: res.error,
              options: ["重试", "终止任务"],
            });
            resolve(false);
            return;
          }
          // 被硬拦截或等待询问时 resolve(false) 已在 onWorkerEvent 处理
          resolve(false);
        })
        .catch((e) => {
          this.store.updateStep(task, step.id, { status: "failed", detail: String(e.message) });
          resolve(false);
        });
    });
  }

  /** 工人事件 → 右栏展示 + 权限策略执行。 */
  private onWorkerEvent(task: Task, step: Step, e: WorkerEvent, resolveStep: (ok: boolean) => void): void {
    switch (e.kind) {
      case "message":
        publish({ type: "worker-output", projectDir: this.projectDir, taskId: task.id, text: e.text ?? "" });
        break;
      case "reasoning":
        publish({ type: "worker-output", projectDir: this.projectDir, taskId: task.id, text: `[思考] ${e.text ?? ""}` });
        break;
      case "command": {
        publish({
          type: "worker-command",
          projectDir: this.projectDir,
          taskId: task.id,
          command: e.command ?? "",
          output: e.output,
          exitCode: e.exitCode,
        });
        // YOLO 模式：命令已自动放行，写入自动处理记录（需求 6.4 / A6）
        if (getConfig().permissionMode === "yolo" && e.exitCode !== undefined) {
          const { rule } = classifyCommand(e.command ?? "", "yolo");
          this.ledger.record("yolo", "allow", e.command ?? "", rule);
          publish({
            type: "auto-approve",
            projectDir: this.projectDir,
            taskId: task.id,
            action: e.command ?? "",
            rule: rule?.label ?? "",
          });
        }
        break;
      }
      case "error":
        publish({ type: "worker-output", projectDir: this.projectDir, taskId: task.id, text: `[错误] ${e.text ?? ""}` });
        break;
      case "fatal":
        publish({ type: "worker-output", projectDir: this.projectDir, taskId: task.id, text: `[致命] ${e.text ?? ""}` });
        break;
      case "permission": {
        if (e.verdict === "block") {
          // 灾难性操作：任何模式都拦截并通知（需求 6.4）
          this.ledger.record(getConfig().permissionMode, "block", e.command ?? "", undefined);
          publish({
            type: "hard-block",
            projectDir: this.projectDir,
            taskId: task.id,
            action: e.command ?? "",
            rule: `${e.ruleId ?? ""} ${e.ruleLabel ?? ""}`,
          });
          publish({ type: "notice", level: "error", text: `已拦截灾难性操作并暂停任务：${e.command}（规则：${e.ruleLabel}）` });
          this.store.updateStep(task, step.id, { status: "failed", detail: `硬拦截: ${e.command}` });
          this.store.forceStatus(task, "paused");
          this.openCard("decision", "危险操作已拦截", {
            decision: "hard_block",
            taskId: task.id,
            stepId: step.id,
            command: e.command,
            ruleLabel: e.ruleLabel,
            options: ["保持暂停", "终止任务"],
          });
          resolveStep(false);
        } else if (e.verdict === "ask") {
          // 分级模式：删除文件等操作 → 决策卡片（需求 6.5 / A6）
          this.openCard("decision", "工人请求权限", {
            decision: "ask_permission",
            taskId: task.id,
            stepId: step.id,
            prompt: this.workerPromptForStep(task, step),
            command: e.command,
            ruleLabel: e.ruleLabel,
            options: ["批准并继续", "拒绝"],
          });
          publish({ type: "notice", level: "warn", text: `分级模式：工人请求执行「${e.ruleLabel}」：${e.command}，已暂停等待你的决定。` });
          resolveStep(false);
        }
        break;
      }
      case "done":
        break;
      default:
        break;
    }
  }

  // ───────────────────────── 验收与修复循环 ─────────────────────────

  private async acceptAndFix(task: Task): Promise<void> {
    const { runAcceptance } = await import("./acceptance/runner");
    let round = 0;
    while (true) {
      if (!this.enforceLimits(task)) return;
      this.store.setStatus(task, "accepting");
      publish({ type: "task-update", projectDir: this.projectDir, task: taskSnapshot(task) });
      const report = await runAcceptance(this.projectDir, this.store, task);
      publish({ type: "acceptance", projectDir: this.projectDir, taskId: task.id, report });

      if (report.allPassed) {
        this.store.setStatus(task, "passed");
        const conclusion = "验收标准全部通过，任务完成。";
        this.store.setConclusion(task, conclusion);
        publish({ type: "notice", level: "info", text: `任务「${task.title}」${conclusion}` });
        return;
      }

      // 失败 → 修复循环
      this.store.setStatus(task, "fixing");
      publish({ type: "task-update", projectDir: this.projectDir, task: taskSnapshot(task) });
      round++;
      const key = errKeyOf(report.problems);
      const attempts = this.store.recordFixAttempt(task, key);
      const max = getConfig().limits.maxFixAttempts;
      if (attempts > max) {
        // 同一错误连续修复超过上限 → 暂停 + 决策卡片（需求 6.6.2）
        this.store.forceStatus(task, "paused");
        publish({ type: "notice", level: "error", text: `同一问题已修复 ${attempts - 1} 次仍未解决，任务已暂停，等待你决定。` });
        this.openCard("decision", "修复次数已达上限", {
          decision: "retry_loop",
          taskId: task.id,
          errorKey: key,
          attempts: attempts - 1,
          problems: report.problems,
          options: ["再试一次", "终止任务"],
        });
        return;
      }

      publish({
        type: "notice",
        level: "warn",
        text: `验收未通过（第 ${round} 轮），已把 ${report.problems.length} 条问题发给工人修复（第 ${attempts}/${max} 次）。`,
      });
      const prompt = this.workerPromptForFix(task, report.problems, attempts);
      const step = task.steps[Math.min(task.currentStepIndex, task.steps.length - 1)];
      const ok = await this.runWorkerStep(task, step, prompt, task.threadId);
      if (!ok) return; // 暂停/失败已在卡片处理
    }
  }

  /** 总步数/总时长上限（需求 6.6.3）。返回 false 表示已触发上限并弹卡片，调用方应停止。 */
  private enforceLimits(task: Task): boolean {
    const cfg = getConfig().limits;
    if (task.steps.length > cfg.maxStepsPerTask) {
      publish({ type: "notice", level: "warn", text: `步骤数超过上限 ${cfg.maxStepsPerTask}，剩余步骤不再执行，可在设置中心调整上限。` });
      return false;
    }
    const mins = (Date.now() - this.taskStartedAt) / 60000;
    if (mins > cfg.maxMinutesPerTask) {
      this.store.forceStatus(task, "paused");
      publish({ type: "notice", level: "error", text: `任务超过总时长上限 ${cfg.maxMinutesPerTask} 分钟，已暂停，等待你决定。` });
      this.openCard("decision", "任务超时", {
        decision: "timeout",
        taskId: task.id,
        minutes: Math.round(mins),
        options: ["再给一段时间", "终止任务"],
      });
      return false;
    }
    return true;
  }

  // ───────────────────────── 决策处理 ─────────────────────────

  /** 使用者在决策卡片上做出选择。 */
  async decide(cardId: string, choice: string): Promise<void> {
    const card = this.settleCard(cardId, "answered", choice);
    if (!card || card.kind !== "decision") return;
    const p = card.payload;
    switch (p.decision) {
      case "worker_failed":
      case "ask_permission": {
        if (choice === "重试" || choice === "批准并继续") {
          const task = this.store.getTask(p.taskId);
          if (!task) return;
          const step = task.steps.find((s) => s.id === p.stepId) ?? task.steps[0];
          if (p.decision === "worker_failed") {
            this.store.setStatus(task, "in_progress");
            void this.runTaskLoop(task);
          } else {
            // 批准后重跑该步骤，并在提示词中注明用户已批准该类操作
            const approvedPrompt = `${p.prompt}\n\n（使用者已明确批准本次会话中的操作：${p.command}）`;
            this.store.setStatus(task, "in_progress");
            void (async () => {
              this.running = true;
              try {
                const ok = await this.runWorkerStep(task, step, approvedPrompt, task["threadId"]);
                if (ok) {
                  this.store.updateStep(task, step.id, { status: "passed", detail: "工人执行完成" });
                  // 继续后续步骤
                  task.currentStepIndex = task.steps.indexOf(step) + 1;
                  void this.runTaskLoop(task);
                }
              } finally {
                this.running = false;
              }
            })();
          }
        } else {
          const task = this.store.getTask(p.taskId);
          if (task) {
            this.store.forceStatus(task, "paused");
            this.store.setConclusion(task, "使用者选择终止/拒绝，任务已暂停");
            publish({ type: "notice", level: "warn", text: "任务已按你的选择暂停。" });
          }
        }
        break;
      }
      case "retry_loop": {
        const task = this.store.getTask(p.taskId);
        if (!task) return;
        if (choice === "再试一次") {
          // 重置该错误签名计数，重新进入验收-修复循环
          delete task.fixAttempts[p.errorKey];
          this.store.save();
          this.running = true;
          this.acceptAndFix(task)
            .catch((e) => warn("orchestrator", `修复循环异常: ${e.message}`))
            .finally(() => (this.running = false));
        } else {
          this.store.setConclusion(task, "使用者选择终止任务");
          publish({ type: "notice", level: "warn", text: "任务已终止。" });
        }
        break;
      }
      case "resume_task": {
        const task = this.store.getTask(p.taskId);
        if (!task) return;
        if (choice === "继续执行") {
          info("orchestrator", `恢复未完成任务: ${task.id}`);
          void this.runTaskLoop(task);
        } else {
          this.store.forceStatus(task, "paused");
          publish({ type: "notice", level: "info", text: `任务「${p.title ?? task.id}」保持暂停，可稍后继续。` });
        }
        break;
      }
      case "install_tool": {
        if (choice === "安装") {
          const { fixTool } = await import("./envcheck/check");
          const r = await fixTool(p.tool);
          publish({ type: "notice", level: r.ok ? "info" : "error", text: `环境修复: ${r.detail}` });
        }
        break;
      }
      case "hard_block":
      case "timeout":
      default:
        publish({ type: "notice", level: "info", text: `你选择了「${choice}」。` });
        break;
    }
  }

  // ───────────────────────── git 快照与回滚 ─────────────────────────

  private gitIdentityEnv(): Record<string, string> {
    return {
      GIT_AUTHOR_NAME: "dispatch-center",
      GIT_AUTHOR_EMAIL: "dispatch@local",
      GIT_COMMITTER_NAME: "dispatch-center",
      GIT_COMMITTER_EMAIL: "dispatch@local",
    };
  }

  /**
   * 任务开始前的 git 快照（需求 6.4 安全网）。
   * 实现说明：用 git write-tree + commit-tree 生成快照提交对象，仅写入独立引用
   * refs/dispatch/snapshots —— 不在任何分支上产生提交，不污染使用者的提交历史。
   */
  async snapshot(label: string): Promise<void> {
    const { runInProject } = await import("./acceptance/runner");
    if (!fs.existsSync(path.join(this.projectDir, ".git"))) {
      await runInProject(this.projectDir, "git init");
    }
    await runInProject(this.projectDir, "git add -A");
    const tree = await runInProject(this.projectDir, "git write-tree");
    if (tree.exitCode !== 0) {
      warn("orchestrator", `git write-tree 失败: ${tree.output}`);
      return;
    }
    const commit = await runInProject(
      this.projectDir,
      `git commit-tree ${tree.output.trim()} -m "dispatch-snapshot: ${label}"`,
      60,
      this.gitIdentityEnv()
    );
    if (commit.exitCode !== 0) {
      warn("orchestrator", `git commit-tree 失败: ${commit.output}`);
      return;
    }
    await runInProject(this.projectDir, `git update-ref refs/dispatch/snapshots ${commit.output.trim()}`);
    info("orchestrator", `git 快照完成: ${label} (${commit.output.trim().slice(0, 8)})`);
  }

  /** 一键回滚到最近一次快照：恢复快照中的文件，并删除快照之后新增的文件（.dispatch 状态目录除外）。 */
  async rollback(): Promise<{ ok: boolean; detail: string }> {
    const { runInProject } = await import("./acceptance/runner");
    const ref = await runInProject(this.projectDir, "git rev-parse refs/dispatch/snapshots");
    if (ref.exitCode !== 0) return { ok: false, detail: "没有可用的快照" };
    const restore = await runInProject(
      this.projectDir,
      "git restore --source=refs/dispatch/snapshots --worktree --staged -- .",
      120,
      this.gitIdentityEnv()
    );
    if (restore.exitCode !== 0) return { ok: false, detail: `回滚失败: ${restore.output.slice(-300)}` };
    // 删除快照后才出现的文件（当前未被 git 跟踪、且不在快照树里的）
    const untracked = await runInProject(this.projectDir, "git ls-files --others --exclude-standard");
    const snapFiles = await runInProject(this.projectDir, "git ls-tree -r --name-only refs/dispatch/snapshots");
    const snapSet = new Set(snapFiles.output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    const removed: string[] = [];
    for (const rel of untracked.output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      if (rel.startsWith(".dispatch")) continue;
      if (snapSet.has(rel)) continue;
      try {
        const abs = safeJoin(this.projectDir, rel);
        fs.rmSync(abs, { force: true });
        removed.push(rel);
      } catch {
        /* 单个文件删除失败不阻断 */
      }
    }
    publish({ type: "notice", level: "info", text: `已回滚到最近一次任务快照（删除了 ${removed.length} 个快照后新增的文件）。` });
    return { ok: true, detail: "已回滚到最近一次快照" };
  }

  // ───────────────────────── 重启恢复（A8） ─────────────────────────

  /** 服务启动/切换项目后调用：把未完成任务恢复出来并给出继续入口（含因修复上限而暂停的任务）。 */
  recoverPendingTasks(): void {
    const tasks = this.store.current.tasks;
    const pending = tasks.filter((t) =>
      ["in_progress", "accepting", "fixing", "waiting_user", "paused"].includes(t.status)
    );
    for (const t of pending) {
      this.openCard("decision", "检测到未完成任务", {
        decision: "resume_task",
        taskId: t.id,
        title: t.title,
        status: TASK_STATUS_LABEL[t.status],
        step: `${t.currentStepIndex}/${t.steps.length}`,
        options: ["继续执行", "保持暂停"],
      });
    }
    if (pending.length) {
      publish({ type: "notice", level: "warn", text: `从状态文件恢复了 ${pending.length} 个未完成任务，请在卡片上选择继续或保持暂停。` });
    }
  }
}

function taskSnapshot(task: Task) {
  return JSON.parse(JSON.stringify(task));
}

/** 渐进解析（转发 brain 模块实现）。 */
import { extractTextProgressive } from "./brain/brain";
function parseProgressive(buf: string) {
  return extractTextProgressive(buf);
}

export const orchestrator = new Orchestrator();

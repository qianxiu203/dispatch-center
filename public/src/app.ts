/**
 * 调度中心 v2 前端（需求 7/9/13/14）：
 * - 三栏 100vh 固定布局，各栏独立滚动（13.1）；<1100px 右栏收起为抽屉。
 * - api() 显式传 method（14.1 契约），全部请求带访问令牌（16.2）。
 * - SSE 事件流：手动重连，指数退避 1s→30s，带 lastEventId 补发并按 id 去重（L9）。
 * - 会话：新建/清除归档/打开归档/上下文占用；流式增量渲染，中途刷新恢复已生成部分（7.4/9.2）。
 * - 卡片：需求确认、决策按钮、工人提问自由文本回答。
 * - 目录选择器：后端目录浏览接口画目录树与面包屑，支持新建文件夹（13.3）。
 * - 按钮防重：点击立即禁用，响应返回后恢复；聊天/创建任务带 requestId（M10/V13）。
 * - 错误展示「发生了什么 / 影响 / 下一步」三段（13.7）。
 */
type ProjectView = {
  path: string;
  name: string;
  startCommand?: string;
  busy: boolean;
  taskCount: number;
  tasks: TaskView[];
};

interface TaskView {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  currentStepIndex: number;
  steps: { id: string; title: string; status: string; detail?: string }[];
  criteria: { id: string; text: string; kind: string }[];
  criteriaStatus: Record<string, { status: string; detail?: string; evidence?: string }>;
  fixAttempts: { seq: number; signature: string; changedFiles: string[] }[];
  pausedReason?: string;
  snapshotRef?: string;
  loops: Record<string, any>;
}

interface CardView {
  id: string;
  kind: "requirement" | "decision";
  title: string;
  payload: any;
  status: string;
}

interface StateView {
  config: any;
  permissionRules: { hardBlock: { id: string; label: string }[]; ask: { id: string; label: string }[] };
  projects: ProjectView[];
  cards: (CardView & { projectDir?: string; taskId?: string })[];
  autoApprovals: any[];
  watchdog: any[];
  currentEventId: number;
  platform: string;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

let state: StateView | null = null;
let streaming = false;
let currentProject = "";
let activeSession = "";
let lastEventId = 0;
const renderedCards = new Set<string>();
const expandedProjects = new Set<string>();

// ───────────────────────── 令牌与 api（14.1/16.2） ─────────────────────────

function initToken(): void {
  const q = new URLSearchParams(location.search);
  const t = q.get("token");
  if (t) {
    localStorage.setItem("dc-token", t);
    q.delete("token");
    const rest = q.toString();
    history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : ""));
  }
}

function token(): string {
  return localStorage.getItem("dc-token") ?? "";
}

/** 显式 method 的 api 调用（14.1：禁止按是否有 body 推断方法）。 */
async function api<T = any>(method: string, path: string, body?: any): Promise<T> {
  if (!method) throw new Error("api() 必须显式传 method");
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "x-dispatch-token": token() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new ApiError("访问令牌无效", "界面无法读取数据", "请关闭页面，回到终端重新运行 start.sh 打开（地址里自带令牌）");
  if (!res.ok) {
    const msg = (data as any).message ?? (data as any).error ?? `HTTP ${res.status}`;
    throw new ApiError(msg, "操作未完成", "请检查输入内容后重试；若持续失败，可在设置中心导出诊断包");
  }
  return ((data as any).data ?? data) as T;
}

class ApiError extends Error {
  constructor(message: string, public impact: string, public next: string) {
    super(message);
  }
}

// ───────────────────────── 工具 ─────────────────────────

function toast(text: string, isError = false): void {
  const item = document.createElement("div");
  item.className = "toast-item" + (isError ? " error" : "");
  item.textContent = text;
  $("#toast").appendChild(item);
  setTimeout(() => item.remove(), 5000);
}

/** 错误三段式展示（13.7）：发生了什么 / 影响 / 下一步，技术详情默认折叠。 */
function showError(what: string, impact: string, next: string, detail?: string): void {
  const item = el("div", "toast-item error three-part");
  const h = el("b");
  h.textContent = "发生了什么：";
  const p1 = el("div");
  p1.append(h, document.createTextNode(what));
  const h2 = el("b");
  h2.textContent = "影响：";
  const p2 = el("div");
  p2.append(h2, document.createTextNode(impact));
  const h3 = el("b");
  h3.textContent = "下一步：";
  const p3 = el("div");
  p3.append(h3, document.createTextNode(next));
  item.append(p1, p2, p3);
  if (detail) {
    const det = el("details", "tech-detail");
    const sum = el("summary");
    sum.textContent = "技术详情";
    det.append(sum, el("pre")).textContent = "";
    det.querySelector("pre")!.textContent = String(detail).slice(0, 2000);
    item.appendChild(det);
  }
  $("#toast").appendChild(item);
  setTimeout(() => item.remove(), 9000);
}

function toastApiError(e: any): void {
  if (e instanceof ApiError) showError(e.message, e.impact, e.next);
  else showError(String(e?.message ?? e), "操作未完成", "请重试；若持续失败，请在设置中心导出诊断包");
}

function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function uuid(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 按钮防重（13.8/M10）：包装 onclick，点击立即禁用，完成后恢复。 */
function withBusy(btn: HTMLButtonElement, fn: () => Promise<void>): void {
  if (btn.disabled) return;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "进行中…";
  fn()
    .catch((e) => toastApiError(e))
    .finally(() => {
      btn.disabled = false;
      btn.textContent = old;
    });
}

// ───────────────────────── 聊天区 ─────────────────────────

function addMsg(kind: "user" | "assistant" | "system" | "notice" | "divider" | "summary", text: string): HTMLElement {
  const m = el("div", `msg ${kind}`);
  m.textContent = text;
  $("#chatMessages").appendChild(m);
  scrollChat();
  return m;
}

function scrollChat(): void {
  const sc = $("#chatScroll");
  sc.scrollTop = sc.scrollHeight;
}

async function loadSessionMessages(): Promise<void> {
  if (!currentProject) return;
  try {
    const sess = await api<any>("GET", `/api/sessions?project=${encodeURIComponent(currentProject)}`);
    activeSession = sess.activeId;
    renderSessionSelect(sess.sessions, sess.activeId);
    const msgs = await api<any>("GET", `/api/sessions/${encodeURIComponent(sess.activeId)}/messages?project=${encodeURIComponent(currentProject)}`);
    const box = $("#chatMessages");
    box.innerHTML = "";
    // 聊天区整体重建：去重集合一并重置，打开中的卡片由下方恢复循环重新渲染
    // （SSE 先渲染过、随后聊天区被清空的卡片不能因此丢失）
    renderedCards.clear();
    for (const l of msgs.lines ?? []) {
      if (l.kind === "assistant_delta") continue; // read() 已合并
      const kind = l.kind === "divider" ? "divider" : l.kind === "summary" ? "summary" : l.kind === "compact_notice" ? "notice" : (l.kind as any);
      addMsg(kind, l.text);
    }
    updateCtxUsage(msgs.usage?.percent ?? 0);
    // 恢复打开中的卡片：卡片不落盘，会话区每次重建都要从服务端取当前打开卡片
    // （session-update 等事件触发重建时，内存里的 state.cards 可能还是旧值）
    try {
      const cc = await api<any>("GET", `/api/cards?project=${encodeURIComponent(currentProject)}`);
      for (const c of cc.cards ?? []) {
        if ((c as any).projectDir && (c as any).projectDir !== currentProject) continue;
        if (!renderedCards.has(c.id)) {
          renderedCards.add(c.id);
          renderCard(c);
        }
      }
    } catch {
      /* 卡片拉取失败不阻塞聊天渲染 */
    }
  } catch (e) {
    toastApiError(e);
  }
}

function updateCtxUsage(percent: number): void {
  const badge = $("#ctxUsage");
  badge.textContent = `上下文 ${percent}%`;
  badge.classList.toggle("warn", percent >= 70);
}

function renderSessionSelect(sessions: any[], activeId: string): void {
  const sel = $("#sessionSelect") as HTMLSelectElement;
  sel.innerHTML = "";
  const visible = (sessions ?? []).slice(0, 30);
  for (const s of visible) {
    const opt = el("option") as HTMLOptionElement;
    opt.value = s.id;
    opt.textContent = s.id === activeId ? `当前会话 ${s.title}` : `${s.title}（归档）`;
    sel.appendChild(opt);
  }
  sel.value = activeId;
  sel.onchange = async () => {
    try {
      await api("POST", `/api/sessions/${encodeURIComponent(sel.value)}/open?project=${encodeURIComponent(currentProject)}`);
      await loadSessionMessages();
    } catch (e) {
      toastApiError(e);
    }
  };
}

async function sendMessage(text: string): Promise<void> {
  if (!currentProject) {
    toast("请先在左侧添加并选择项目", true);
    return;
  }
  if (streaming) return;
  streaming = true;
  $("#runBadge").classList.remove("hidden");
  addMsg("user", text);
  const bubble = addMsg("assistant", "");
  let received = "";
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-dispatch-token": token() },
      body: JSON.stringify({ project: currentProject, message: text, requestId: uuid() }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
      throw new Error((err as any).message ?? `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let evt: any;
        try {
          evt = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (evt.type === "chat-delta" && evt.text) {
          received += evt.text;
          bubble.textContent = received;
          scrollChat();
        } else if (evt.type === "chat-done" && evt.error) {
          throw new Error(evt.error);
        }
      }
    }
    if (!received) bubble.textContent = "（大脑没有返回内容，请检查设置中心的大脑配置）";
    // 刷新上下文占用与会话（7.4：流式增量已落盘）
    loadSessionMessages().catch(() => {});
  } catch (e: any) {
    bubble.textContent = received ? received + `\n\n[出错] ${e.message}` : `[出错] ${e.message}`;
    showError(e.message, "这条消息没有得到回复", "请检查大脑配置后重新发送", e.stack);
  } finally {
    streaming = false;
    $("#runBadge").classList.add("hidden");
    scrollChat();
  }
}

// ───────────────────────── 卡片 ─────────────────────────

function renderCard(card: CardView & { projectDir?: string }, prepend = false): HTMLElement {
  const box = el("div", `card ${card.kind}`);
  if (card.status !== "open") box.classList.add("status-settled");
  const h = el("h4");
  h.textContent = card.title;
  box.appendChild(h);

  if (card.kind === "requirement") {
    const body = el("div", "card-body");
    body.textContent = `【需求】${card.payload.requirement}`;
    box.appendChild(body);
    const ul = el("ul", "criteria");
    for (const c of card.payload.criteria ?? []) {
      const li = el("li");
      li.textContent = `${c.id}. ${c.text}（${kindLabel(c.kind)}）`;
      ul.appendChild(li);
    }
    box.appendChild(ul);
    const actions = el("div", "card-actions");
    const okBtn = el("button", "btn primary");
    okBtn.textContent = "确认开工";
    okBtn.onclick = () =>
      withBusy(okBtn, async () => {
        await api("POST", `/api/cards/${encodeURIComponent(card.id)}/confirm`, { project: currentProject });
        markCard(box, "已确认，已加入任务队列…");
        await refreshState();
      });
    const noBtn = el("button", "btn");
    noBtn.textContent = "取消";
    noBtn.onclick = () => markCard(box, "已取消，请继续对话修改需求。");
    actions.append(okBtn, noBtn);
    box.appendChild(actions);
  } else {
    const body = el("div", "card-body");
    body.textContent = decisionText(card.payload);
    box.appendChild(body);
    const actions = el("div", "card-actions");
    // 工人提问：支持自由文本回答（7.2 answer）
    if (card.payload.decision === "worker_question") {
      const input = el("input", "text-input") as HTMLInputElement;
      input.placeholder = "输入你的回答…";
      const ansBtn = el("button", "btn primary");
      ansBtn.textContent = "回答并继续";
      ansBtn.onclick = () =>
        withBusy(ansBtn, async () => {
          const text = input.value.trim();
          if (!text) {
            toast("请输入回答内容", true);
            return;
          }
          await api("POST", `/api/cards/${encodeURIComponent(card.id)}/answer`, { project: currentProject, text });
          markCard(box, `已回答：${text}`);
        });
      const cancelBtn = el("button", "btn");
      cancelBtn.textContent = "取消任务";
      cancelBtn.onclick = () =>
        withBusy(cancelBtn, async () => {
          await api("POST", `/api/cards/${encodeURIComponent(card.id)}/answer`, { project: currentProject, choice: "取消任务" });
          markCard(box, "已取消任务");
        });
      actions.append(input, ansBtn, cancelBtn);
    }
    for (const opt of card.payload.options ?? []) {
      if (card.payload.decision === "worker_question" && opt === "取消任务") continue;
      const b = el("button", opt.includes("取消") || opt === "拒绝" || opt === "暂不" ? "btn" : "btn primary");
      b.textContent = opt;
      b.onclick = () =>
        withBusy(b, async () => {
          await api("POST", `/api/cards/${encodeURIComponent(card.id)}/answer`, { project: currentProject, choice: opt });
          markCard(box, `已选择：${opt}`);
          await refreshState();
        });
      actions.appendChild(b);
    }
    box.appendChild(actions);
  }

  const container = $("#chatMessages");
  if (prepend) container.prepend(box);
  else container.appendChild(box);
  scrollChat();
  return box;
}

function markCard(box: HTMLElement, text: string): void {
  box.classList.add("status-settled");
  box.querySelectorAll(".card-actions button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
  const tag = box.querySelector(".settled-tag") ?? el("div", "settled-tag");
  tag.textContent = text;
  if (!tag.parentElement) box.appendChild(tag);
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "web_console_clean": return "网页无控制台报错";
    case "web_url": return "网页可打开";
    case "file_exists": return "文件存在";
    case "command_exit_0": return "命令执行成功";
    default: return kind;
  }
}

function decisionText(p: any): string {
  switch (p.decision) {
    case "resume_task": return `任务已暂停${p.reason ? `：${p.reason}` : ""}。可以继续执行、保持暂停或取消。`;
    case "loop_stop": return `${p.kind ?? "循环"}停止：${p.reason ?? ""}\n已尝试 ${p.attempts ?? 0} 次修复。可选择再试、修改验收标准、跳过该标准或取消任务。`;
    case "loop_stop_await_criteria": return "任务保持暂停。修改完验收标准后点「已改好，重新验收」。";
    case "hard_block": return `工人重复请求被禁止的操作，已暂停任务：\n${p.command}`;
    case "worker_question": return `工人提问：${p.question}\n（${p.reason ?? ""}）`;
    case "worker_unavailable": return `工人不可用：${p.error}\n最近心跳：${p.heartbeat ?? "无"}`;
    case "dispatch_blocked": return `工人判断问题出在调度中心一侧（不计入修复次数）：\n${p.reason}`;
    case "ask_permission": return `工人请求执行「${p.ruleLabel ?? ""}」：\n${p.command}\n是否批准？`;
    case "control_confirm": return `请确认对任务「${p.taskTitle ?? p.taskId}」执行「${controlLabel(p.action)}」。`;
    case "criteria_invalid": return `验收标准无法自动检查：\n${(p.errors ?? []).map((x: string) => "· " + x).join("\n")}\n任务未创建。`;
    case "install_tool": return `是否安装/修复环境组件：${p.tool}？（便携安装到调度中心目录）`;
    default: return JSON.stringify(p);
  }
}

function controlLabel(action: string): string {
  return action === "pause" ? "暂停" : action === "cancel" ? "取消" : action === "resume" ? "恢复" : action;
}

// ───────────────────────── 右栏各块 ─────────────────────────

const STATUS_TEXT: Record<string, string> = {
  todo: "待办",
  in_progress: "进行中",
  queued: "排队中",
  running: "执行中",
  verifying: "验收中",
  fixing: "修复中",
  passed: "通过",
  failed: "失败",
  cancelled: "已取消",
  paused: "已暂停",
  waiting_user: "等待我决定",
  pending: "待检",
};

function currentTasks(): TaskView[] {
  return state?.projects.find((p) => p.path === currentProject)?.tasks ?? [];
}

function latestTask(): TaskView | undefined {
  const tasks = currentTasks();
  return tasks.find((t) => ["running", "verifying", "fixing", "waiting_user", "paused"].includes(t.status)) ?? tasks[tasks.length - 1];
}

function renderTimeline(): void {
  const box = $("#timeline");
  box.innerHTML = "";
  const tasks = currentTasks();
  if (tasks.length === 0) {
    box.innerHTML = `<div class="empty">暂无任务</div>`;
  } else {
    const task = latestTask();
    const title = el("div", "task-title");
    title.textContent = `队列（${tasks.length}）· 最新：${task?.title ?? ""}`;
    box.appendChild(title);
    for (const t of tasks.slice(-8).reverse()) {
      const row = el("div", "task-line");
      const st = el("span", `st ${t.status}`);
      st.textContent = t.statusLabel;
      const name = el("span");
      name.textContent = `${t.title}（步骤 ${t.currentStepIndex}/${t.steps.length}）`;
      row.append(st, name);
      box.appendChild(row);
    }
    if (task) {
      const meta = el("div", "task-meta");
      meta.textContent = `修复尝试：${task.fixAttempts?.length ?? 0} 次${task.pausedReason ? `；暂停原因：${task.pausedReason}` : ""}`;
      box.appendChild(meta);
    }
  }
  renderTaskButtons();
  renderSteps();
}

/** 任务按钮（6.5）：按状态显示 暂停/恢复/取消/移除/回滚。 */
function renderTaskButtons(): void {
  let bar = $("#taskBtnBar") as HTMLElement | null;
  if (!bar) {
    bar = el("div", "task-btn-bar");
    bar.id = "taskBtnBar";
    $("#timeline").after(bar);
  }
  bar.innerHTML = "";
  for (const t of currentTasks().slice(-3).reverse()) {
    const row = el("div", "btn-row");
    const label = el("span", "btn-row-label");
    label.textContent = `${t.title}`;
    row.appendChild(label);
    const mk = (text: string, fn: () => Promise<void>, primary = false) => {
      const b = el("button", `btn small${primary ? " primary" : ""}`) as HTMLButtonElement;
      b.textContent = text;
      b.onclick = () => withBusy(b, async () => { await fn(); await refreshState(); });
      row.appendChild(b);
    };
    if (["running", "verifying", "fixing"].includes(t.status)) mk("暂停", () => api("POST", `/api/tasks/${encodeURIComponent(t.id)}/pause?project=${encodeURIComponent(currentProject)}`));
    if (t.status === "paused") mk("恢复", () => api("POST", `/api/tasks/${encodeURIComponent(t.id)}/resume?project=${encodeURIComponent(currentProject)}`), true);
    if (!["passed", "failed", "cancelled"].includes(t.status)) mk("取消", () => api("POST", `/api/tasks/${encodeURIComponent(t.id)}/cancel?project=${encodeURIComponent(currentProject)}`));
    if (!["running", "verifying", "fixing"].includes(t.status)) mk("移除", () => api("POST", `/api/tasks/${encodeURIComponent(t.id)}/remove?project=${encodeURIComponent(currentProject)}`));
    if (["passed", "failed", "cancelled", "paused"].includes(t.status)) mk("回滚", () => api("POST", `/api/tasks/${encodeURIComponent(t.id)}/rollback?project=${encodeURIComponent(currentProject)}`));
    bar.appendChild(row);
  }
}

function renderSteps(): void {
  const task = latestTask();
  const box = $("#timeline");
  if (!task) return;
  const wrap = el("div", "steps-wrap");
  for (const s of task.steps ?? []) {
    const row = el("div", "step");
    const sst = el("span", `st ${s.status}`);
    sst.textContent = STATUS_TEXT[s.status] ?? s.status;
    const sname = el("span");
    sname.textContent = `${s.id} ${s.title}`;
    row.append(sst, sname);
    wrap.appendChild(row);
  }
  // 验收结果明细
  for (const [id, v] of Object.entries(task.criteriaStatus ?? {})) {
    if (v.status === "pending") continue;
    const c = task.criteria.find((x) => x.id === id);
    const row = el("div", "acc-item");
    const v2 = el("span", `verdict ${v.status === "passed" ? "passed" : "failed"}`);
    v2.textContent = v.status === "passed" ? "通过" : "失败";
    row.append(v2, document.createTextNode(` ${c?.text ?? id}${v.detail ? `：${v.detail.split("\n")[0]}` : ""}`));
    if (v.evidence) {
      const shot = el("span", "shot");
      shot.textContent = " [截图]";
      shot.onclick = () => openScreenshot(v.evidence!);
      row.appendChild(shot);
    }
    wrap.appendChild(row);
  }
  box.appendChild(wrap);
}

function appendWorkerLine(text: string): void {
  const box = $("#workerOut");
  if (box.querySelector(".empty")) box.innerHTML = "";
  const line = el("div", "worker-line");
  line.textContent = text;
  box.appendChild(line);
  while (box.children.length > 300) box.removeChild(box.firstChild!);
  box.scrollTop = box.scrollHeight;
}

function renderAcceptance(report: any): void {
  const box = $("#acceptance");
  if (box.querySelector(".empty")) box.innerHTML = "";
  const wrap = el("div");
  const head = el("div", "task-meta");
  head.textContent = report.allPassed ? `✅ 全部通过（${new Date().toLocaleTimeString()}）` : `❌ 未全部通过（${new Date().toLocaleTimeString()}）`;
  wrap.appendChild(head);
  for (const r of report.results ?? []) {
    const item = el("div", "acc-item");
    const v = el("span", `verdict ${r.passed ? "passed" : "failed"}`);
    v.textContent = r.passed ? "通过" : "失败";
    item.append(v, document.createTextNode(` ${r.criterionId}：${r.detail.split("\n")[0]}`));
    if (r.evidence && r.evidence.endsWith(".png")) {
      const shot = el("span", "shot");
      shot.textContent = " [截图]";
      shot.onclick = () => openScreenshot(r.evidence);
      item.appendChild(shot);
    }
    wrap.appendChild(item);
  }
  if ((report.harnessErrors ?? []).length) {
    const he = el("div", "err-item");
    he.textContent = `调度侧缺陷 ${report.harnessErrors.length} 条（不派工人，让大脑重新生成标准）`;
    wrap.appendChild(he);
  }
  box.prepend(wrap);
}

function renderConsoleErrors(problems: any[]): void {
  const box = $("#consoleErrors");
  if (box.querySelector(".empty")) box.innerHTML = "";
  for (const p of problems) {
    const item = el("div", "err-item");
    item.textContent = p.summary ?? p.message ?? JSON.stringify(p);
    box.prepend(item);
  }
}

function renderAutoLog(rec: any): void {
  const box = $("#autoLog");
  if (box.querySelector(".empty")) box.innerHTML = "";
  const item = el("div", "auto-item");
  const v = el("span", `v-${rec.verdict === "allow" ? "allow" : rec.verdict === "block" ? "block" : "ask"}`);
  v.textContent = rec.verdict === "allow" ? "[自动批准]" : rec.verdict === "block" ? "[已拦截]" : "[待询问]";
  item.append(v, document.createTextNode(` ${new Date(rec.time).toLocaleTimeString()} ${rec.action}${rec.ruleLabel ? `（${rec.ruleLabel}）` : ""}`));
  box.prepend(item);
}

/** 循环状态（13.5 新增块）。 */
function renderLoops(loops: Record<string, any> | undefined): void {
  const box = $("#loops");
  box.innerHTML = "";
  const entries = Object.entries(loops ?? {});
  if (entries.length === 0) {
    box.innerHTML = `<div class="empty">暂无进行中的循环</div>`;
    return;
  }
  for (const [, rec] of entries) {
    const row = el("div", "loop-item");
    const head = el("div", "loop-head");
    head.textContent = `${rec.kind} ${rec.loopId} · 第 ${rec.iteration}/${rec.maxIterations} 次`;
    row.appendChild(head);
    const meta = el("div", "loop-meta");
    const remain = Math.max(0, rec.maxIterations - rec.iteration);
    meta.textContent = `剩余预算 ${remain}；无进展 ${rec.noProgressCount}/${rec.maxNoProgress}${rec.lastSignature ? `；签名 ${String(rec.lastSignature).slice(0, 8)}` : ""}${rec.stopped ? `；已停止：${rec.stopReason ?? ""}` : ""}`;
    row.appendChild(meta);
    box.appendChild(row);
  }
}

/** 看门狗（13.5 新增块）。 */
function renderWatchdog(usage: any[]): void {
  const box = $("#watchdog");
  box.innerHTML = "";
  if (!usage || usage.length === 0) {
    box.innerHTML = `<div class="empty">暂无运行中任务</div>`;
    return;
  }
  for (const u of usage) {
    const mins = Math.round((Date.now() - new Date(u.startedAt).getTime()) / 60000);
    const row = el("div", "loop-item");
    row.textContent = `${u.title}：已运行 ${mins} 分钟，工人 ${u.workerCalls} 次，大脑 ${u.brainCalls} 次，静默 ${Math.round((Date.now() - new Date(u.lastActivityAt).getTime()) / 60000)} 分钟`;
    box.appendChild(row);
  }
}

function openScreenshot(name: string): void {
  const pop = el("div", "screenshot-pop");
  const img = document.createElement("img");
  img.src = `/api/screenshot?name=${encodeURIComponent(name)}&token=${encodeURIComponent(token())}`;
  pop.appendChild(img);
  pop.onclick = () => pop.remove();
  document.body.appendChild(pop);
}

// ───────────────────────── 左栏项目 ─────────────────────────

function projectDotOf(tasks: TaskView[]): string {
  if (tasks.some((t) => ["running", "verifying", "fixing"].includes(t.status))) return "active";
  if (tasks.some((t) => t.status === "waiting_user")) return "waiting";
  if (tasks.some((t) => t.status === "paused")) return "paused";
  if (tasks.some((t) => t.status === "failed")) return "error";
  return "idle";
}

function renderProjects(): void {
  const list = $("#projectList");
  list.innerHTML = "";
  if (!state || state.projects.length === 0) {
    const li = el("li");
    li.textContent = "还没有项目，点上方「添加项目」";
    list.appendChild(li);
    return;
  }
  for (const p of state.projects) {
    const li = el("li");
    if (p.path === currentProject) li.classList.add("active");
    const dot = el("span", `dot ${projectDotOf(p.tasks)}`);
    dot.title = { active: "进行中", waiting: "等待我决定", paused: "已暂停", error: "出错", idle: "空闲" }[projectDotOf(p.tasks)] ?? "";
    const name = el("span");
    name.textContent = `${p.name}（${p.tasks.length} 任务）`;
    name.title = p.path;
    li.append(dot, name);
    li.onclick = async () => {
      currentProject = p.path;
      expandedProjects.add(p.path);
      await loadSessionMessages();
      renderProjects();
      renderTimeline();
    };
    list.appendChild(li);
    // 展开的任务列表（6.5）
    if (expandedProjects.has(p.path) && p.tasks.length > 0) {
      const sub = el("ul", "task-sublist");
      for (const t of p.tasks) {
        const tli = el("li", "task-sub");
        tli.textContent = `${t.statusLabel} · ${t.title}`;
        sub.appendChild(tli);
      }
      list.appendChild(sub);
    }
  }
}

// ───────────────────────── 目录选择器（13.3） ─────────────────────────

let dirCursor = "";
let dirOnPick: ((p: string) => void) | null = null;

function openDirPicker(onPick: (p: string) => void): void {
  dirOnPick = onPick;
  $("#dirModal").classList.remove("hidden");
  browseDir("");
}

async function browseDir(p: string): Promise<void> {
  try {
    const data = await api<any>("GET", `/api/fs/list?path=${encodeURIComponent(p)}`);
    dirCursor = data.path ?? "";
    $("#dirSelected").textContent = dirCursor || "（Windows 请选择盘符）";
    renderDirCrumb(data);
    renderDirList(data);
  } catch (e) {
    toastApiError(e);
  }
}

function renderDirCrumb(data: any): void {
  const crumb = $("#dirCrumb");
  crumb.innerHTML = "";
  if (data.drives) {
    const root = el("span", "crumb-item");
    root.textContent = "此电脑";
    crumb.appendChild(root);
    return;
  }
  const parts = (data.path ?? "").split(/[\\/]/).filter(Boolean);
  const rootBtn = el("span", "crumb-item");
  rootBtn.textContent = process_platformRoot();
  rootBtn.onclick = () => browseDir("");
  crumb.appendChild(rootBtn);
  let acc = data.path?.startsWith("/") ? "" : "";
  parts.forEach((part: string, i: number) => {
    acc = data.path?.startsWith("/") ? `${acc}/${part}` : `${acc}${part}\\`;
    const b = el("span", "crumb-item" + (i === parts.length - 1 ? " current" : ""));
    b.textContent = part;
    b.onclick = () => browseDir(i === 0 ? (data.path?.startsWith("/") ? "/" : acc) : acc);
    crumb.appendChild(b);
  });
  if (data.parent) {
    const up = el("span", "crumb-item up");
    up.textContent = "← 上一级";
    up.onclick = () => browseDir(data.parent);
    crumb.appendChild(up);
  }
}

function process_platformRoot(): string {
  return state?.platform === "win32" ? "此电脑" : "/";
}

function renderDirList(data: any): void {
  const list = $("#dirList");
  list.innerHTML = "";
  if (data.drives) {
    for (const d of data.drives) {
      const row = el("div", "dir-row");
      row.textContent = d;
      row.onclick = () => browseDir(d);
      list.appendChild(row);
    }
    return;
  }
  if ((data.dirs ?? []).length === 0) {
    list.innerHTML = `<div class="empty">没有子目录</div>`;
  }
  for (const d of data.dirs ?? []) {
    const row = el("div", "dir-row");
    row.textContent = `📁 ${d.split(/[\\/]/).pop()}`;
    row.title = d;
    const enter = el("span", "dir-enter");
    enter.textContent = "进入";
    enter.onclick = (ev) => {
      ev.stopPropagation();
      browseDir(d);
    };
    const pick = el("span", "dir-pick");
    pick.textContent = "选这个";
    pick.onclick = (ev) => {
      ev.stopPropagation();
      dirCursor = d;
      $("#dirSelected").textContent = d;
    };
    row.append(enter, pick);
    row.onclick = () => {
      dirCursor = d;
      $("#dirSelected").textContent = d;
    };
    list.appendChild(row);
  }
}

// ───────────────────────── 设置中心 ─────────────────────────

async function openSettings(): Promise<void> {
  // 先弹出再加载：环境体检 / 记忆 / MCP 任一失败都不应让设置中心打不开
  $("#settingsModal").classList.remove("hidden");
  try {
      const c = state?.config ?? {};
    $("#cfgBrainUrl").value = c.brain?.baseUrl ?? "";
    $("#cfgBrainKey").value = "";
    $("#cfgBrainModel").value = c.brain?.model ?? "";
    $("#cfgCtxMax").value = c.brain?.maxContextTokens ?? 32768;
    $("#cfgWorkerPath").value = c.worker?.executablePath ?? "";
    $("#cfgWorkerUrl").value = c.worker?.baseUrl ?? "";
    $("#cfgWorkerModel").value = c.worker?.model ?? "";
    $("#cfgWorkerKey").value = "";
    $("#cfgSandboxNet").checked = c.worker?.sandboxNetworkAccess !== false;
    $("#cfgDanger").checked = c.worker?.dangerFullAccess === true;
    $("#cfgPermMode").value = c.permissionMode ?? "yolo";
    $("#cfgMaxFixSig").value = c.limits?.maxFixPerSignature ?? 3;
    $("#cfgMaxTotalFix").value = c.limits?.maxTotalFixes ?? 6;
    $("#cfgMaxQuestions").value = c.limits?.maxWorkerQuestions ?? 15;
    $("#cfgMaxSteps").value = c.limits?.maxStepsPerTask ?? 30;
    $("#cfgWdMinutes").value = c.watchdog?.maxTotalMinutes ?? 90;
    $("#cfgWdWorker").value = c.watchdog?.maxWorkerCalls ?? 40;
    $("#cfgWdSilence").value = c.watchdog?.maxSilenceMinutes ?? 10;
    $("#cfgWdBrain").value = c.watchdog?.maxBrainCalls ?? 200;
      renderRules();
      await runEnvCheck();
      await loadMemories();
      await loadMcp();
      await loadHbItems();
  } catch (e) {
    toastApiError(e);
  }
}

function renderRules(): void {
  const r = state?.permissionRules;
  const box = $("#ruleList");
  box.innerHTML = "";
  if (!r) return;
  const hard = el("div", "rule-group");
  hard.innerHTML = `<b>硬性拦截（任何模式都拒绝并终止）：</b><br/>` + r.hardBlock.map((x) => `· ${x.label}`).join("<br/>");
  const ask = el("div", "rule-group");
  ask.innerHTML = `<b>分级询问模式需确认（YOLO 下自动批准并记录）：</b><br/>` + r.ask.map((x) => `· ${x.label}`).join("<br/>");
  box.append(hard, ask);
}

async function loadMemories(): Promise<void> {
  try {
    if (!currentProject) return;
    const proj = await api<any>("GET", `/api/memory?scope=project&project=${encodeURIComponent(currentProject)}`);
    ($("#memProject") as HTMLTextAreaElement).value = proj.raw ?? "";
    const glob = await api<any>("GET", `/api/memory?scope=global&project=${encodeURIComponent(currentProject)}`);
    ($("#memGlobal") as HTMLTextAreaElement).value = glob.raw ?? "";
  } catch (e) {
    toastApiError(e);
  }
}

async function loadMcp(): Promise<void> {
  const box = $("#mcpList");
  box.innerHTML = `<div class="empty">加载中…</div>`;
  try {
    const { servers } = await api<any>("GET", "/api/mcp");
    box.innerHTML = "";
    if (!servers.length) box.innerHTML = `<div class="empty">尚未配置 MCP 服务器</div>`;
    for (const s of servers) {
      const row = el("div", "env-item");
      const badge = el("span", s.enabled ? "ok" : "bad");
      badge.textContent = s.enabled ? "启用" : "停用";
      const name = el("span");
      name.textContent = `${s.name}：${s.command ?? s.url ?? ""}`;
      row.append(badge, name);
      const toggleBtn = el("button", "btn");
      toggleBtn.textContent = s.enabled ? "停用" : "启用";
      toggleBtn.onclick = () =>
        withBusy(toggleBtn, async () => {
          await api("POST", `/api/mcp/${encodeURIComponent(s.name)}/toggle`, { enabled: !s.enabled });
          await loadMcp();
        });
      const testBtn = el("button", "btn");
      testBtn.textContent = "测试连通";
      testBtn.onclick = () =>
        withBusy(testBtn, async () => {
          const r = await api<any>("POST", `/api/mcp/${encodeURIComponent(s.name)}/test`);
          toast(r.ok ? `连通正常，工具 ${r.tools?.length ?? 0} 个` : `测试失败：${r.detail}`, !r.ok);
        });
      const delBtn = el("button", "btn");
      delBtn.textContent = "删除";
      delBtn.onclick = () =>
        withBusy(delBtn, async () => {
          await api("DELETE", `/api/mcp/${encodeURIComponent(s.name)}`);
          await loadMcp();
        });
      row.append(toggleBtn, testBtn, delBtn);
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = `<div class="empty">加载失败：${(e as Error).message}</div>`;
  }
}

async function loadHbItems(): Promise<void> {
  try {
    const r = await api<any>("GET", "/api/heartbeat");
    const box = $("#hbItems");
    box.innerHTML = "";
    const last = r.last;
    if (!last) {
      box.innerHTML = `<div class="empty">尚未检测（心跳每 5 分钟自动运行）</div>`;
      return;
    }
    for (const it of last.items ?? []) {
      const row = el("div", "env-item");
      const badge = el("span", it.ok ? "ok" : "bad");
      badge.textContent = it.ok ? "正常" : "异常";
      row.append(badge, document.createTextNode(`${it.name}：${it.detail}`));
      box.appendChild(row);
    }
  } catch (e) {
    toastApiError(e);
  }
}

async function runEnvCheck(): Promise<void> {
  const box = $("#envcheckList");
  box.innerHTML = `<div class="empty">体检中…</div>`;
  try {
    const { results } = await api<{ results: any[] }>("POST", "/api/envcheck");
    box.innerHTML = "";
    for (const r of results) {
      const item = el("div", "env-item");
      const badge = el("span", r.ok ? "ok" : "bad");
      badge.textContent = r.ok ? "正常" : "缺失";
      const name = el("span");
      name.textContent = `${r.name}：`;
      const detail = el("span", "detail");
      detail.textContent = r.detail;
      item.append(badge, name, detail);
      if (!r.ok && r.fixable) {
        const fixBtn = el("button", "btn") as HTMLButtonElement;
        fixBtn.textContent = "一键修复";
        fixBtn.onclick = () =>
          withBusy(fixBtn, async () => {
            const resp = await api<{ started: boolean; installId?: string; detail: string }>("POST", "/api/envcheck/install", { tool: r.id });
            toast(resp.detail || "安装已开始，请看进度条");
            if (!resp.started) await runEnvCheck();
          });
        item.appendChild(fixBtn);
      }
      box.appendChild(item);
    }
  } catch (e: any) {
    box.innerHTML = `<div class="empty">体检失败：${e.message}</div>`;
  }
}

/** 安装进度条（11.3）：步骤名/百分比或字节速度/取消按钮/详细日志。 */
function renderInstallProgress(prog: any): void {
  const box = $("#installProgress");
  let item = box.querySelector(`[data-id="${prog.installId}"]`) as HTMLElement | null;
  if (!item) {
    item = el("div", "install-item");
    item.dataset.id = prog.installId;
    const head = el("div", "install-head");
    const name = el("b");
    name.textContent = prog.step ?? "安装";
    const pct = el("span", "install-pct");
    const cancelBtn = el("button", "btn small") as HTMLButtonElement;
    cancelBtn.textContent = "取消";
    cancelBtn.onclick = () =>
      withBusy(cancelBtn, async () => {
        await api("POST", "/api/envcheck/cancel", { installId: prog.installId });
        toast("已请求取消安装");
      });
    const log = el("details", "install-log");
    const sum = el("summary");
    sum.textContent = "详细日志";
    const pre = el("pre");
    log.append(sum, pre);
    head.append(name, pct, cancelBtn);
    item.append(head, log);
    box.appendChild(item);
  }
  const pct = item.querySelector(".install-pct")!;
  if (typeof prog.percent === "number") pct.textContent = `${prog.percent.toFixed(1)}%`;
  else if (prog.bytes) pct.textContent = `${(prog.bytes / 1048576).toFixed(1)}MB ${((prog.speedBps ?? 0) / 1048576).toFixed(1)}MB/s`;
  if (prog.log) {
    const pre = item.querySelector("pre")!;
    pre.textContent += `${prog.log}\n`;
  }
  if (prog.done) {
    const head = item.querySelector(".install-head b")!;
    head.textContent = prog.ok ? `完成：${prog.step}` : `失败：${prog.error ?? prog.step}`;
    (item.querySelector("button") as HTMLButtonElement).disabled = true;
  }
}

async function saveSettings(): Promise<void> {
  const patch: any = {
    brain: {
      baseUrl: $("#cfgBrainUrl").value.trim(),
      model: $("#cfgBrainModel").value.trim(),
      maxContextTokens: Number($("#cfgCtxMax").value) || 32768,
    },
    worker: {
      executablePath: $("#cfgWorkerPath").value.trim(),
      baseUrl: $("#cfgWorkerUrl").value.trim(),
      model: $("#cfgWorkerModel").value.trim(),
      sandboxNetworkAccess: $("#cfgSandboxNet").checked,
      dangerFullAccess: $("#cfgDanger").checked,
    },
    permissionMode: $("#cfgPermMode").value,
    limits: {
      maxFixPerSignature: Number($("#cfgMaxFixSig").value) || 3,
      maxTotalFixes: Number($("#cfgMaxTotalFix").value) || 6,
      maxWorkerQuestions: Number($("#cfgMaxQuestions").value) || 15,
      maxStepsPerTask: Number($("#cfgMaxSteps").value) || 30,
    },
    watchdog: {
      maxTotalMinutes: Number($("#cfgWdMinutes").value) || 90,
      maxWorkerCalls: Number($("#cfgWdWorker").value) || 40,
      maxSilenceMinutes: Number($("#cfgWdSilence").value) || 10,
      maxBrainCalls: Number($("#cfgWdBrain").value) || 200,
    },
  };
  const brainKey = $("#cfgBrainKey").value.trim();
  if (brainKey) patch.brain.apiKey = brainKey;
  const workerKey = $("#cfgWorkerKey").value.trim();
  if (workerKey) patch.worker.apiKey = workerKey;
  try {
    await api("POST", "/api/config", patch);
    toast("设置已保存");
    $("#settingsModal").classList.add("hidden");
    await refreshState();
  } catch (e: any) {
    toastApiError(e);
  }
}

// ───────────────────────── 首次引导（13.6） ─────────────────────────

const GUIDE_STEPS = [
  { title: "① 配置大脑并测试连接", body: "打开「设置中心」→ 大脑，填写 OpenAI 兼容接口的 Base URL、API Key 和模型名，点「测试连接」确认可用。" },
  { title: "② 环境体检", body: "设置中心 → 环境体检，确认 Node、Git、工人 CLI、浏览器都正常。缺失项可一键修复，安装过程有进度条，可取消。" },
  { title: "③ 添加项目", body: "点左栏「添加项目」，用目录选择器选择或新建一个空文件夹作为项目目录（网页无法直接读取本地路径，所以由这里代选）。" },
  { title: "④ 说一个小需求", body: "在中间聊天框用中文描述需求（如「做一个静态欢迎页」）。大脑会复述需求并给出验收标准，确认后自动开工。" },
  { title: "⑤ 看右栏进度", body: "右栏实时显示任务时间线、工人输出、验收结果、循环状态与看门狗。完成与否以自动验收为准，可以随时暂停/取消任务。" },
];

let guideStep = 0;

function showGuide(step: number): void {
  guideStep = Math.max(0, Math.min(4, step));
  $("#guideStep").textContent = String(guideStep + 1);
  const c = $("#guideContent");
  c.innerHTML = "";
  const h = el("h3");
  h.textContent = GUIDE_STEPS[guideStep].title;
  const p = el("p");
  p.textContent = GUIDE_STEPS[guideStep].body;
  c.append(h, p);
  ($("#guidePrev" as HTMLButtonElement).disabled = guideStep === 0);
  $("#guideNext").textContent = guideStep === 4 ? "完成" : "下一步";
  $("#guideModal").classList.remove("hidden");
}

function closeGuide(): void {
  $("#guideModal").classList.add("hidden");
  localStorage.setItem("dc2-onboarded", "1");
}

// ───────────────────────── 状态与事件 ─────────────────────────

async function refreshState(): Promise<void> {
  state = await api<StateView>("GET", "/api/state");
  if (!currentProject && state.projects.length > 0) currentProject = state.projects[0].path;
  const cur = state.projects.find((p) => p.path === currentProject);
  $("#currentProjectName").textContent = cur ? `${cur.name} — ${cur.path}` : "未选择项目";
  $("#runBadge").classList.toggle("hidden", !cur?.busy);
  $("#busyHint").classList.toggle("hidden", !cur?.busy);
  renderProjects();
  renderTimeline();
  renderLoopsFromState();
  renderWatchdog(state.watchdog);
  for (const c of state.cards) {
    if (!renderedCards.has(c.id)) {
      renderedCards.add(c.id);
      renderCard(c);
    }
  }
}

function renderLoopsFromState(): void {
  const cur = state?.projects.find((p) => p.path === currentProject);
  const loops: Record<string, any> = {};
  for (const t of cur?.tasks ?? []) {
    for (const [k, v] of Object.entries(t.loops ?? {})) loops[`${t.id}:${k}`] = v;
  }
  renderLoops(loops);
}

/** SSE 重连（L9）：指数退避 1s→30s，带 lastEventId 补发，按 id 去重。 */
let es: EventSource | null = null;
let backoff = 1000;

function connectEvents(): void {
  if (es) es.close();
  es = new EventSource(`/api/events?token=${encodeURIComponent(token())}&lastEventId=${lastEventId}`);
  es.onopen = () => {
    backoff = 1000;
  };
  es.onmessage = (m) => {
    let e: any;
    try {
      e = JSON.parse(m.data);
    } catch {
      return;
    }
    if (typeof e.id === "number") {
      if (e.id <= lastEventId) return; // 补发去重（L9/V11）
      lastEventId = e.id;
    }
    handleEvent(e);
  };
  es.onerror = () => {
    es?.close();
    es = null;
    setTimeout(() => {
      connectEvents();
      backoff = Math.min(30000, backoff * 2);
    }, backoff);
  };
}

function handleEvent(e: any): void {
  const forCurrent = !e.projectDir || e.projectDir === currentProject;
  switch (e.type) {
    case "card":
      if (!renderedCards.has(e.card.id)) {
        renderedCards.add(e.card.id);
        renderCard(e.card);
      }
      break;
    case "notice": {
      const m = addMsg("notice", e.text);
      if (e.level === "error") m.classList.add("error");
      if (e.level !== "info") toast(e.text, e.level === "error");
      refreshState().catch(() => {});
      break;
    }
    case "worker-output":
      if (forCurrent) appendWorkerLine(e.text);
      break;
    case "worker-command":
      if (forCurrent) appendWorkerLine(`$ ${e.command}${e.exitCode !== undefined && e.exitCode !== null ? `（退出码 ${e.exitCode}）` : ""}`);
      break;
    case "acceptance":
      if (forCurrent) {
        renderAcceptance(e.report);
        renderConsoleErrors(e.report.problems ?? []);
        refreshState().catch(() => {});
      }
      break;
    case "auto-approve":
      renderAutoLog({ verdict: "allow", time: new Date().toISOString(), action: e.action, ruleLabel: e.rule });
      break;
    case "hard-block":
      renderAutoLog({ verdict: "block", time: new Date().toISOString(), action: e.action, ruleLabel: e.rule });
      toast(`已拦截危险操作：${e.action}`, true);
      break;
    case "task-update":
      if (forCurrent) refreshState().catch(() => {});
      break;
    case "envcheck-progress":
      renderInstallProgress(e);
      break;
    case "heartbeat":
      refreshHbDot(e.dot, e.summary);
      break;
    case "loop-update":
      refreshState().catch(() => {});
      break;
    case "session-update":
      if (forCurrent && e.sessionId === activeSession) loadSessionMessages().catch(() => {});
      break;
    case "memory-update":
      if ($("#settingsModal").classList.contains("hidden") === false) loadMemories().catch(() => {});
      break;
    default:
      break;
  }
}

function refreshHbDot(dot: string, summary: string): void {
  const d = $("#hbDot");
  d.className = `dot ${dot === "red" ? "error" : dot === "yellow" ? "waiting" : "done"}`;
  $("#hbText").textContent = summary;
}

// ───────────────────────── 初始化 ─────────────────────────

function init(): void {
  initToken();
  $("#chatForm").onsubmit = (ev) => {
    ev.preventDefault();
    const input = $("#chatInput") as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    void sendMessage(text);
  };
  $("#addProjectBtn").onclick = () => openDirPicker(async (dir) => {
    try {
      await api("POST", "/api/projects", { path: dir });
      $("#dirModal").classList.add("hidden");
      await refreshState();
      currentProject = dir;
      await loadSessionMessages();
      renderProjects();
      toast("项目已添加");
    } catch (e) {
      const errBox = $("#dirError");
      errBox.classList.remove("hidden");
      errBox.textContent = e instanceof ApiError
        ? `${e.message}；影响：${e.impact}；下一步：${e.next}`
        : String((e as Error).message);
    }
  });
  $("#dirClose").onclick = () => $("#dirModal").classList.add("hidden");
  $("#dirMkdirBtn").onclick = () =>
    withBusy($("#dirMkdirBtn") as HTMLButtonElement, async () => {
      const name = ($("#dirNewName") as HTMLInputElement).value.trim();
      if (!name || !dirCursor) {
        toast("请先进入一个目录再新建文件夹", true);
        return;
      }
      await api("POST", "/api/fs/mkdir", { path: dirCursor, name });
      ($("#dirNewName") as HTMLInputElement).value = "";
      await browseDir(dirCursor);
    });
  $("#dirOkBtn").onclick = () => {
    if (!dirCursor) {
      toast("请先选择一个目录", true);
      return;
    }
    $("#dirModal").classList.add("hidden");
    dirOnPick?.(dirCursor);
  };
  $("#newChatBtn").onclick = () =>
    withBusy($("#newChatBtn") as HTMLButtonElement, async () => {
      if (!currentProject) return;
      const r = await api<any>("POST", "/api/sessions", { project: currentProject });
      activeSession = r.sessionId;
      await loadSessionMessages();
      toast("已新建对话（旧会话已归档）");
    });
  $("#clearChatBtn").onclick = () =>
    withBusy($("#clearChatBtn") as HTMLButtonElement, async () => {
      if (!activeSession) return;
      // 默认归档；永久删除需二次确认（9.2）
      if (confirm("清除聊天记录？\n确定 = 归档（可再次打开）\n取消 = 不做任何事\n要永久删除请在会话列表归档后到设置里操作。")) {
        await api("POST", `/api/sessions/${encodeURIComponent(activeSession)}/archive?project=${encodeURIComponent(currentProject)}`);
        await loadSessionMessages();
        toast("已归档并开启新会话");
      }
    });
  $("#settingsBtn").onclick = () => void openSettings();
  $("#settingsClose").onclick = () => $("#settingsModal").classList.add("hidden");
  $("#settingsSave").onclick = () => withBusy($("#settingsSave") as HTMLButtonElement, saveSettings);
  $("#guideBtn").onclick = () => showGuide(0);
  $("#guideAgainBtn").onclick = () => showGuide(0);
  $("#guideSkip").onclick = closeGuide;
  $("#guideNext").onclick = () => (guideStep === 4 ? closeGuide() : showGuide(guideStep + 1));
  $("#guidePrev").onclick = () => showGuide(guideStep - 1);
  $("#testBrainBtn").onclick = () =>
    withBusy($("#testBrainBtn") as HTMLButtonElement, async () => {
      $("#testBrainResult").textContent = "测试中…";
      await api("POST", "/api/config", {
        brain: {
          baseUrl: $("#cfgBrainUrl").value.trim(),
          model: $("#cfgBrainModel").value.trim(),
          maxContextTokens: Number($("#cfgCtxMax").value) || 32768,
          ...($("#cfgBrainKey").value.trim() ? { apiKey: $("#cfgBrainKey").value.trim() } : {}),
        },
      });
      const r = await api<{ ok: boolean; detail: string }>("POST", "/api/config/test-brain");
      $("#testBrainResult").textContent = r.ok ? `✅ ${r.detail}` : `❌ ${r.detail}`;
    });
  $("#envcheckBtn").onclick = () => withBusy($("#envcheckBtn") as HTMLButtonElement, runEnvCheck);
  $("#hbRunBtn").onclick = () =>
    withBusy($("#hbRunBtn") as HTMLButtonElement, async () => {
      const r = await api<any>("POST", "/api/heartbeat/run");
      $("#hbRunResult").textContent = r.ok ? "✅ 核心项正常" : "⚠ 有异常项，详见下方";
      await loadHbItems();
    });
  $("#memProjectSave").onclick = () =>
    withBusy($("#memProjectSave") as HTMLButtonElement, async () => {
      await api("POST", "/api/memory", { project: currentProject, scope: "project", id: null, text: ($("#memProject") as HTMLTextAreaElement).value });
      toast("项目记忆已保存");
    });
  $("#memGlobalSave").onclick = () =>
    withBusy($("#memGlobalSave") as HTMLButtonElement, async () => {
      await api("POST", "/api/memory", { project: currentProject || ".", scope: "global", id: null, text: ($("#memGlobal") as HTMLTextAreaElement).value });
      toast("全局记忆已保存");
    });
  $("#memProjectReload").onclick = () => withBusy($("#memProjectReload") as HTMLButtonElement, loadMemories);
  $("#mcpAddBtn").onclick = () =>
    withBusy($("#mcpAddBtn") as HTMLButtonElement, async () => {
      const name = ($("#mcpName") as HTMLInputElement).value.trim();
      const command = ($("#mcpCommand") as HTMLInputElement).value.trim();
      if (!name || !command) {
        toast("请填写名称与命令", true);
        return;
      }
      if (!confirm("第三方 MCP 可以执行任意操作，确认添加？")) return;
      const parts = command.split(/\s+/);
      await api("POST", "/api/mcp", { name, command: parts[0], args: parts.slice(1) });
      ($("#mcpName") as HTMLInputElement).value = "";
      ($("#mcpCommand") as HTMLInputElement).value = "";
      await loadMcp();
      toast("MCP 已添加（下一个任务生效）");
    });
  $("#skillPreviewBtn").onclick = () =>
    withBusy($("#skillPreviewBtn") as HTMLButtonElement, async () => {
      const src = ($("#skillSource") as HTMLInputElement).value.trim();
      const source = /^(https?:\/\/|git@)/.test(src) ? { gitUrl: src } : { dir: src };
      const r = await api<any>("POST", "/api/skills/preview", source);
      const box = $("#skillFiles");
      box.innerHTML = "";
      const head = el("div", "task-meta");
      head.textContent = r.ok ? `将复制 ${r.files.length} 个文件到 ${r.targetDir}` : r.detail;
      box.appendChild(head);
      for (const f of r.files.slice(0, 50)) {
        const row = el("div", "worker-line");
        row.textContent = f;
        box.appendChild(row);
      }
    });
  $("#skillImportBtn").onclick = () =>
    withBusy($("#skillImportBtn") as HTMLButtonElement, async () => {
      const src = ($("#skillSource") as HTMLInputElement).value.trim();
      if (!confirm("第三方 skills 可以影响工人行为，确认导入？")) return;
      const source = /^(https?:\/\/|git@)/.test(src) ? { gitUrl: src } : { dir: src };
      const r = await api<any>("POST", "/api/skills/import", source);
      toast(r.ok ? `导入 ${r.files.length} 个文件（下一个任务生效）` : `导入失败：${r.detail}`, !r.ok);
    });
  // 右栏折叠（13.5：各块可折叠）
  document.querySelectorAll<HTMLElement>(".panel .toggle").forEach((h) => {
    h.onclick = () => {
      const body = h.nextElementSibling as HTMLElement;
      body.classList.toggle("collapsed");
      h.textContent = h.textContent!.replace(body.classList.contains("collapsed") ? "▾" : "▸", body.classList.contains("collapsed") ? "▸" : "▾");
    };
  });
  // <1100px 右栏抽屉（13.1）
  const applyResponsive = () => {
    $("#rightToggle").classList.toggle("hidden", window.innerWidth >= 1100);
    if (window.innerWidth >= 1100) $("#right").classList.remove("drawer-open");
  };
  $("#rightToggle").onclick = () => $("#right").classList.toggle("drawer-open");
  window.addEventListener("resize", applyResponsive);
  applyResponsive();

  connectEvents();
  refreshState()
    .then(async () => {
      await loadSessionMessages();
      if (!localStorage.getItem("dc2-onboarded")) showGuide(0);
      else if (state && !state.config?.brain?.baseUrl) {
        addMsg("assistant", "欢迎使用调度中心！请先点左下角「设置中心」填写大脑接口与 API Key，再添加项目开始第一个需求。");
      }
    })
    .catch((e) => toastApiError(e));
}

init();

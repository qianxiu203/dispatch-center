/**
 * 前端逻辑（需求 5 三栏界面）：
 * - 中栏聊天：POST /api/chat 的 SSE 流式渲染（chat-delta 逐段追加）。
 * - 需求确认卡片 / 决策卡片：点按钮调 /api/chat/confirm、/api/chat/decide。
 * - 右栏：/api/events 的 SSE 事件驱动（任务时间线、工人输出、验收结果、报错、自动处理记录）。
 * - 设置中心：读改 /api/config、测试连接、环境体检与一键修复。
 */
type Dot = "active" | "waiting" | "done" | "error" | "idle";

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
  projects: { path: string; name: string; dot: Dot; lastStatus: string }[];
  currentProject: string;
  task: any;
  cards: CardView[];
  autoApprovals: any[];
  running: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

let state: StateView | null = null;
let streaming = false;
let workerOutExpanded = false;

// ───────────────────────── 工具 ─────────────────────────

function toast(text: string, isError = false): void {
  const item = document.createElement("div");
  item.className = "toast-item" + (isError ? " error" : "");
  item.textContent = text;
  $("#toast").appendChild(item);
  setTimeout(() => item.remove(), 5000);
}

function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

async function api<T = any>(path: string, body?: any): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error ?? `HTTP ${res.status}`);
  return data as T;
}

// ───────────────────────── 聊天区 ─────────────────────────

function addMsg(kind: "user" | "assistant" | "notice" | "error", text: string): HTMLElement {
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

async function sendMessage(text: string): Promise<void> {
  if (streaming) return;
  streaming = true;
  $("#runBadge").classList.remove("hidden");
  addMsg("user", text);
  const bubble = addMsg("assistant", "");
  let received = "";
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error((err as any).error);
    }
    // 解析 SSE 流（分块到达，逐段渲染 —— 需求 4.1）
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
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
  } catch (e: any) {
    bubble.textContent = received ? received + `\n\n[出错] ${e.message}` : `[出错] ${e.message}`;
    toast(e.message, true);
  } finally {
    streaming = false;
    $("#runBadge").classList.add("hidden");
    scrollChat();
  }
}

// ───────────────────────── 卡片 ─────────────────────────

function renderCard(card: CardView, prepend = false): HTMLElement {
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
    okBtn.onclick = async () => {
      okBtn.disabled = true;
      try {
        await api("/api/chat/confirm", { cardId: card.id });
        markCard(box, "已确认，开始执行…");
      } catch (e: any) {
        toast(e.message, true);
        okBtn.disabled = false;
      }
    };
    const noBtn = el("button", "btn");
    noBtn.textContent = "取消";
    noBtn.onclick = () => {
      markCard(box, "已取消，请继续对话修改需求。");
    };
    actions.append(okBtn, noBtn);
    box.appendChild(actions);
  } else {
    const body = el("div", "card-body");
    body.textContent = decisionText(card.payload);
    box.appendChild(body);
    const actions = el("div", "card-actions");
    for (const opt of card.payload.options ?? []) {
      const b = el("button", opt === "终止任务" || opt === "拒绝" ? "btn" : "btn primary");
      b.textContent = opt;
      b.onclick = async () => {
        b.disabled = true;
        try {
          await api("/api/chat/decide", { cardId: card.id, choice: opt });
          markCard(box, `已选择：${opt}`);
        } catch (e: any) {
          toast(e.message, true);
          b.disabled = false;
        }
      };
      actions.appendChild(b);
    }
    box.appendChild(actions);
  }

  if (card.status !== "open") markCard(box, card.status === "confirmed" ? "已确认" : "已处理");
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
    case "resume_task": return `检测到未完成任务「${p.title}」（状态：${p.status}，步骤 ${p.step}）。是否继续执行？`;
    case "retry_loop": return `同一问题已修复 ${p.attempts} 次仍未通过验收。问题摘录：\n${(p.problems ?? []).slice(0, 3).map((x: any) => "· " + x.message).join("\n")}`;
    case "hard_block": return `检测到灾难性操作，已拦截并暂停任务：\n${p.command}\n规则：${p.ruleLabel}`;
    case "worker_failed": return `工人执行失败：${p.error}`;
    case "ask_permission": return `工人请求执行「${p.ruleLabel}」：\n${p.command}\n是否批准？`;
    case "timeout": return `任务超过总时长上限（${p.minutes} 分钟），已暂停。`;
    case "install_tool": return `是否安装/修复环境组件：${p.tool}？（便携安装到调度中心目录）`;
    default: return JSON.stringify(p);
  }
}

// ───────────────────────── 右栏 ─────────────────────────

const STATUS_TEXT: Record<string, string> = {
  todo: "待办",
  in_progress: "进行中",
  accepting: "验收中",
  fixing: "修复中",
  passed: "通过",
  failed: "失败",
  paused: "已暂停",
  waiting_user: "等待我决定",
  pending: "待检",
};

function renderTimeline(task: any): void {
  const box = $("#timeline");
  box.innerHTML = "";
  if (!task) {
    box.innerHTML = `<div class="empty">暂无任务</div>`;
    return;
  }
  const title = el("div", "task-title");
  title.textContent = `任务：${task.title}`;
  const meta = el("div", "task-meta");
  meta.textContent = `状态：${task.statusLabel}　步骤进度：${task.currentStepIndex}/${(task.steps ?? []).length}`;
  box.append(title, meta);

  const line = el("div", "task-line");
  const st = el("span", `st ${task.status}`);
  st.textContent = STATUS_TEXT[task.status] ?? task.status;
  const name = el("span");
  name.textContent = task.title;
  line.append(st, name);
  box.appendChild(line);

  for (const s of task.steps ?? []) {
    const row = el("div", "step");
    const sst = el("span", `st ${s.status}`);
    sst.textContent = STATUS_TEXT[s.status] ?? s.status;
    const sname = el("span");
    sname.textContent = `${s.id} ${s.title}${s.detail ? `（${s.detail}）` : ""}`;
    row.append(sst, sname);
    box.appendChild(row);
  }
  if (task.conclusion) {
    const con = el("div", "task-meta");
    con.textContent = `结论：${task.conclusion}`;
    box.appendChild(con);
  }
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
    const t = el("span");
    t.textContent = ` ${r.criterionId}：${r.detail}`;
    item.append(v, t);
    if (r.screenshot) {
      const shot = el("span", "shot");
      shot.textContent = " [截图]";
      shot.onclick = () => openScreenshot(r.screenshot);
      item.appendChild(shot);
    }
    wrap.appendChild(item);
  }
  box.prepend(wrap);
}

function renderConsoleErrors(problems: any[]): void {
  const box = $("#consoleErrors");
  if (box.querySelector(".empty")) box.innerHTML = "";
  for (const p of problems) {
    const item = el("div", "err-item");
    const src = el("span", "src");
    src.textContent = `[${sourceLabel(p.source)}] `;
    const body = el("span");
    body.textContent = `${p.pageUrl ? p.pageUrl + " — " : ""}${p.message}`;
    item.append(src, body);
    box.prepend(item);
  }
}

function sourceLabel(s: string): string {
  switch (s) {
    case "browser_console": return "控制台";
    case "browser_page": return "页面异常";
    case "browser_network": return "网络请求";
    case "browser_navigation": return "导航";
    case "command": return "命令";
    case "file": return "文件";
    default: return s;
  }
}

function renderAutoLog(rec: any): void {
  const box = $("#autoLog");
  if (box.querySelector(".empty")) box.innerHTML = "";
  const item = el("div", "auto-item");
  const v = el("span", `v-${rec.verdict === "allow" ? "allow" : rec.verdict === "block" ? "block" : "ask"}`);
  v.textContent = rec.verdict === "allow" ? "[自动批准]" : rec.verdict === "block" ? "[已拦截]" : "[待询问]";
  const body = el("span");
  body.textContent = ` ${new Date(rec.time).toLocaleTimeString()} ${rec.action}${rec.ruleLabel ? `（${rec.ruleLabel}）` : ""}`;
  item.append(v, body);
  box.prepend(item);
}

function openScreenshot(name: string): void {
  const pop = el("div", "screenshot-pop");
  const img = document.createElement("img");
  img.src = `/api/screenshot?name=${encodeURIComponent(name)}`;
  pop.appendChild(img);
  pop.onclick = () => pop.remove();
  document.body.appendChild(pop);
}

// ───────────────────────── 左栏项目 ─────────────────────────

function renderProjects(): void {
  const list = $("#projectList");
  list.innerHTML = "";
  if (!state || state.projects.length === 0) {
    const li = el("li");
    li.textContent = "还没有项目";
    list.appendChild(li);
    return;
  }
  for (const p of state.projects) {
    const li = el("li");
    if (p.path === state.currentProject) li.classList.add("active");
    const dot = el("span", `dot ${p.dot}`);
    dot.title = { active: "进行中", waiting: "等待我决定", done: "已完成", error: "出错", idle: "空闲" }[p.dot];
    const name = el("span");
    name.textContent = `${p.name}（${p.lastStatus}）`;
    name.title = p.path;
    li.append(dot, name);
    li.onclick = async () => {
      try {
        await api("/api/projects/switch", { path: p.path });
        await refreshState();
        toast(`已切换到项目：${p.name}`);
      } catch (e: any) {
        toast(e.message, true);
      }
    };
    list.appendChild(li);
  }
}

// ───────────────────────── 设置中心 ─────────────────────────

function openSettings(): void {
  const c = state?.config ?? {};
  $("#cfgBrainUrl").value = c.brain?.baseUrl ?? "";
  $("#cfgBrainKey").value = "";
  $("#cfgBrainModel").value = c.brain?.model ?? "";
  $("#cfgWorkerKind").value = c.worker?.kind ?? "codex";
  $("#cfgWorkerPath").value = c.worker?.executablePath ?? "";
  $("#cfgWorkerUrl").value = c.worker?.baseUrl ?? "";
  $("#cfgWorkerModel").value = c.worker?.model ?? "";
  $("#cfgWorkerKey").value = "";
  $("#cfgPermMode").value = c.permissionMode ?? "yolo";
  $("#cfgMaxFix").value = c.limits?.maxFixAttempts ?? 3;
  $("#cfgMaxSteps").value = c.limits?.maxStepsPerTask ?? 30;
  $("#cfgMaxMinutes").value = c.limits?.maxMinutesPerTask ?? 60;
  renderRules();
  runEnvCheck();
  $("#settingsModal").classList.remove("hidden");
}

function renderRules(): void {
  const r = state?.permissionRules;
  const box = $("#ruleList");
  box.innerHTML = "";
  if (!r) return;
  const hard = el("div", "rule-group");
  hard.innerHTML = `<b>硬性拦截（任何模式都拒绝）：</b><br/>` + r.hardBlock.map((x) => `· ${x.label}`).join("<br/>");
  const ask = el("div", "rule-group");
  ask.innerHTML = `<b>分级询问模式需确认（YOLO 下自动批准并记录）：</b><br/>` + r.ask.map((x) => `· ${x.label}`).join("<br/>");
  box.append(hard, ask);
}

async function runEnvCheck(): Promise<void> {
  const box = $("#envcheckList");
  box.innerHTML = `<div class="empty">体检中…</div>`;
  try {
    const { results } = await api<{ results: any[] }>("/api/envcheck");
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
        const fixBtn = el("button", "btn");
        fixBtn.textContent = "一键修复";
        fixBtn.onclick = async () => {
          fixBtn.disabled = true;
          fixBtn.textContent = "安装中…";
          try {
            const resp = await api<{ ok: boolean; detail: string }>("/api/envcheck/fix", { tool: r.id });
            toast(resp.detail);
            await runEnvCheck();
          } catch (e: any) {
            toast(e.message, true);
            fixBtn.disabled = false;
            fixBtn.textContent = "一键修复";
          }
        };
        item.appendChild(fixBtn);
      }
      box.appendChild(item);
    }
  } catch (e: any) {
    box.innerHTML = `<div class="empty">体检失败: ${e.message}</div>`;
  }
}

async function saveSettings(): Promise<void> {
  const patch: any = {
    brain: { baseUrl: $("#cfgBrainUrl").value.trim(), model: $("#cfgBrainModel").value.trim() },
    worker: {
      kind: $("#cfgWorkerKind").value,
      executablePath: $("#cfgWorkerPath").value.trim(),
      baseUrl: $("#cfgWorkerUrl").value.trim(),
      model: $("#cfgWorkerModel").value.trim(),
    },
    permissionMode: $("#cfgPermMode").value,
    limits: {
      maxFixAttempts: Number($("#cfgMaxFix").value) || 3,
      maxStepsPerTask: Number($("#cfgMaxSteps").value) || 30,
      maxMinutesPerTask: Number($("#cfgMaxMinutes").value) || 60,
    },
  };
  const brainKey = $("#cfgBrainKey").value.trim();
  if (brainKey) patch.brain.apiKey = brainKey;
  const workerKey = $("#cfgWorkerKey").value.trim();
  if (workerKey) patch.worker.apiKey = workerKey;
  try {
    await api("/api/config", patch);
    toast("设置已保存");
    $("#settingsModal").classList.add("hidden");
    await refreshState();
  } catch (e: any) {
    toast(e.message, true);
  }
}

// ───────────────────────── 状态与事件 ─────────────────────────

async function refreshState(): Promise<void> {
  state = await api<StateView>("/api/state");
  $("#currentProjectName").textContent = state.currentProject || "未选择项目";
  $("#runBadge").classList.toggle("hidden", !state.running);
  renderProjects();
  renderTimeline(state.task);
  // 打开中的卡片渲染到聊天区（避免重复：已渲染的 id 记录下来）
  for (const c of state.cards) {
    if (!renderedCards.has(c.id)) {
      renderedCards.add(c.id);
      renderCard(c);
    }
  }
}

const renderedCards = new Set<string>();

function connectEvents(): void {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    let e: any;
    try {
      e = JSON.parse(m.data);
    } catch {
      return;
    }
    switch (e.type) {
      case "card":
        if (!renderedCards.has(e.card.id)) {
          renderedCards.add(e.card.id);
          renderCard(e.card);
        }
        break;
      case "card-update": {
        // 状态变化时在已有卡片上打标（简化处理：刷新状态即可）
        break;
      }
      case "task-update":
        if (e.projectDir === state?.currentProject) renderTimeline(e.task);
        break;
      case "step-update":
        break;
      case "worker-output":
        appendWorkerLine(e.text);
        break;
      case "worker-command":
        appendWorkerLine(`$ ${e.command}${e.exitCode !== undefined && e.exitCode !== null ? `（退出码 ${e.exitCode}）` : ""}`);
        break;
      case "acceptance":
        if (e.projectDir === state?.currentProject) {
          renderAcceptance(e.report);
          const problems = (e.report.problems ?? []).filter((p: any) => p.source?.startsWith("browser") || p.source === "command");
          renderConsoleErrors(problems);
        }
        break;
      case "auto-approve":
        renderAutoLog({ verdict: "allow", time: new Date().toISOString(), action: e.action, ruleLabel: e.rule });
        break;
      case "hard-block":
        renderAutoLog({ verdict: "block", time: new Date().toISOString(), action: e.action, ruleLabel: e.rule });
        renderConsoleErrors([{ source: "browser_navigation", message: `灾难性操作已拦截：${e.action}（${e.rule}）` }]);
        toast(`已拦截灾难性操作：${e.action}`, true);
        break;
      case "notice": {
        const m = addMsg("notice", e.text);
        if (e.level === "error") m.classList.add("error");
        if (e.level !== "info") toast(e.text, e.level === "error");
        refreshState().catch(() => {});
        break;
      }
      default:
        break;
    }
  };
  es.onerror = () => {
    // 断线重连由 EventSource 自动进行
  };
}

// ───────────────────────── 初始化 ─────────────────────────

function init(): void {
  $("#chatForm").onsubmit = (ev) => {
    ev.preventDefault();
    const input = $("#chatInput") as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    void sendMessage(text);
  };
  $("#addProjectBtn").onclick = () => {
    $("#addProjectForm").classList.toggle("hidden");
    ($("#addProjectInput") as HTMLInputElement).focus();
  };
  $("#addProjectCancel").onclick = () => $("#addProjectForm").classList.add("hidden");
  $("#addProjectOk").onclick = async () => {
    const dir = ($("#addProjectInput") as HTMLInputElement).value.trim();
    if (!dir) return;
    try {
      await api("/api/projects", { path: dir });
      ($("#addProjectInput") as HTMLInputElement).value = "";
      $("#addProjectForm").classList.add("hidden");
      await refreshState();
      toast("项目已添加");
    } catch (e: any) {
      toast(e.message, true);
    }
  };
  $("#settingsBtn").onclick = openSettings;
  $("#settingsClose").onclick = () => $("#settingsModal").classList.add("hidden");
  $("#settingsSave").onclick = saveSettings;
  $("#testBrainBtn").onclick = async () => {
    $("#testBrainResult").textContent = "测试中…";
    try {
      // 先保存当前填写的大脑配置再测试（Key 留空则沿用已保存的）
      await api("/api/config", {
        brain: {
          baseUrl: $("#cfgBrainUrl").value.trim(),
          model: $("#cfgBrainModel").value.trim(),
          ...($("#cfgBrainKey").value.trim() ? { apiKey: $("#cfgBrainKey").value.trim() } : {}),
        },
      });
      const r = await api<{ ok: boolean; detail: string }>("/api/config/test");
      $("#testBrainResult").textContent = r.ok ? `✅ ${r.detail}` : `❌ ${r.detail}`;
    } catch (e: any) {
      $("#testBrainResult").textContent = `❌ ${e.message}`;
    }
  };
  $("#envcheckBtn").onclick = runEnvCheck;
  $("#workerOutToggle").onclick = () => {
    workerOutExpanded = !workerOutExpanded;
    $("#workerOut").classList.toggle("collapsed", !workerOutExpanded);
    $("#workerOutToggle").textContent = (workerOutExpanded ? "▾" : "▸") + " 工人实时输出";
  };

  connectEvents();
  refreshState()
    .then(() => {
      if (state && !state.config?.brain?.apiKeySet) {
        addMsg("assistant", "欢迎使用调度中心！请先点左下角「设置中心」填写大脑的 API Key，然后在这里描述你的开发需求。");
      }
    })
    .catch((e) => toast(`加载状态失败: ${e.message}`, true));
}

init();

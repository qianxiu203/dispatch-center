/**
 * 会话存储 v2（需求 9.1/9.2/7.4/5.1）：
 * - 每个会话属于一个项目，切换项目即切换会话，项目之间不共享对话上下文。
 * - 会话文件：<项目>/.dispatch/sessions/<sessionId>.jsonl，追加写（流式增量也落盘，
 *   刷新页面/重启程序后从文件恢复，不得整段丢失 —— 需求 7.4）。
 * - 「新建聊天」把旧会话归档（可再次打开）；新会话载入项目记忆摘要 + 任务状态摘要，
 *   不带旧对话原文（需求 9.2）。
 * - 「清除聊天记录」默认归档；「永久删除」需二次确认（由前端传 permanent=true）。
 * - 上下文占用估算：按字符数保守估算（CJK 每 token 约 1~2 字符，按 1 字符=1 token 计，
 *   偏保守会提前压缩，符合「默认保守取 32k」的取向，需求 9.3）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { projectSessionsDir } from "../util/paths";
import { info, warn } from "../logger";

export const SCHEMA_VERSION = 2;

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  archivedAt?: string;
}

export interface SessionsIndex {
  schemaVersion: number;
  projectDir: string;
  activeId: string | null;
  sessions: SessionMeta[];
}

export type ChatLineKind = "user" | "assistant" | "system" | "notice" | "divider" | "assistant_delta" | "summary" | "compact_notice";

export interface ChatLine {
  n: number; // 行内序号
  ts: string;
  kind: ChatLineKind;
  text: string;
  msgId?: string; // assistant_delta 合并用
}

export function estimateTokens(text: string): number {
  // 保守估算：中文约 1 字符/token，英文约 4 字符/token；按 CJK 字符数 + 其余字符/4 估算
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

export class SessionStore {
  private projectDir = "";
  private index: SessionsIndex | null = null;

  load(projectDir: string): SessionsIndex {
    this.projectDir = projectDir;
    const dir = projectSessionsDir(projectDir);
    fs.mkdirSync(dir, { recursive: true });
    const indexFile = path.join(dir, "index.json");
    let index: SessionsIndex | null = null;
    try {
      index = JSON.parse(fs.readFileSync(indexFile, "utf8")) as SessionsIndex;
    } catch {
      index = null;
    }
    if (!index || index.schemaVersion !== SCHEMA_VERSION) {
      // 首次使用：扫描已有 jsonl 文件兜底建立索引；无会话则等待第一条消息时创建
      const sessions: SessionMeta[] = [];
      try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
        for (const f of files) {
          const id = f.replace(/\.jsonl$/, "");
          if (!sessions.some((s) => s.id === id)) {
            sessions.push({ id, title: id, createdAt: fs.statSync(path.join(dir, f)).birthtime.toISOString() });
          }
        }
      } catch {
        /* ignore */
      }
      index = { schemaVersion: SCHEMA_VERSION, projectDir, activeId: sessions[0]?.id ?? null, sessions };
      this.saveIndex(index);
    }
    this.index = index;
    return index;
  }

  get currentIndex(): SessionsIndex {
    if (!this.index) throw new Error("SessionStore 未绑定项目");
    return this.index;
  }

  get activeId(): string | null {
    return this.index?.activeId ?? null;
  }

  private fileOf(sessionId: string): string {
    return path.join(projectSessionsDir(this.projectDir), `${sessionId}.jsonl`);
  }

  private saveIndex(index?: SessionsIndex): void {
    const idx = index ?? this.index!;
    const file = path.join(projectSessionsDir(this.projectDir), "index.json");
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), "utf8");
    fs.renameSync(tmp, file);
  }

  /** 新建会话（旧的归档）；返回新会话 id。 */
  newSession(title?: string): string {
    const idx = this.currentIndex;
    const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (idx.activeId) {
      const old = idx.sessions.find((s) => s.id === idx.activeId);
      if (old && !old.archivedAt) old.archivedAt = new Date().toISOString();
    }
    idx.sessions.unshift({ id, title: title ?? "新对话", createdAt: new Date().toISOString() });
    idx.activeId = id;
    this.saveIndex();
    fs.writeFileSync(this.fileOf(id), "", "utf8");
    this.append(id, { kind: "divider", text: "—— 新对话 ——" });
    info("session", `新建会话 ${id}（旧会话已归档）`);
    return id;
  }

  append(sessionId: string, line: Omit<ChatLine, "n" | "ts"> & { ts?: string }): ChatLine {
    const idx = this.currentIndex;
    if (!idx.sessions.some((s) => s.id === sessionId)) {
      idx.sessions.unshift({ id: sessionId, title: "新对话", createdAt: new Date().toISOString() });
      if (!idx.activeId) idx.activeId = sessionId;
      this.saveIndex();
    }
    const file = this.fileOf(sessionId);
    // 追加前先确保文件存在（首次写入）
    if (!fs.existsSync(file)) fs.writeFileSync(file, "", "utf8");
    const full: ChatLine = { n: this.countLines(sessionId), ts: line.ts ?? new Date().toISOString(), kind: line.kind, text: line.text, msgId: (line as any).msgId };
    fs.appendFileSync(file, JSON.stringify(full) + "\n", "utf8");
    return full;
  }

  private countLines(sessionId: string): number {
    try {
      const data = fs.readFileSync(this.fileOf(sessionId), "utf8");
      return data.split("\n").filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  }

  /** 读取会话内容；连续的 assistant_delta 按 msgId 合并成「已生成的部分」（需求 7.4）。 */
  read(sessionId: string): ChatLine[] {
    const file = this.fileOf(sessionId);
    if (!fs.existsSync(file)) return [];
    const lines: ChatLine[] = [];
    try {
      const data = fs.readFileSync(file, "utf8");
      for (const raw of data.split("\n")) {
        if (!raw.trim()) continue;
        try {
          lines.push(JSON.parse(raw));
        } catch {
          /* 损坏行跳过 */
        }
      }
    } catch {
      return [];
    }
    // 合并 delta：把 assistant_delta 按出现顺序合并为一条 assistant（若其后已有最终 assistant 行则丢弃 delta）
    const out: ChatLine[] = [];
    const deltas = new Map<string, { text: string; ts: string; at: number }>();
    const finalSeen = new Set<string>();
    lines.forEach((l, i) => {
      if (l.kind === "assistant_delta" && l.msgId) {
        const acc = deltas.get(l.msgId) ?? { text: "", ts: l.ts, at: i };
        acc.text += l.text;
        deltas.set(l.msgId, acc);
        return;
      }
      if (l.kind === "assistant" && l.msgId) finalSeen.add(l.msgId);
    });
    const deltaInserted = new Set<string>();
    lines.forEach((l, i) => {
      if (l.kind === "assistant_delta") return;
      if (l.kind === "assistant" && l.msgId && deltas.has(l.msgId) && !deltaInserted.has(l.msgId)) {
        // 在最终行位置展示完整内容（delta 已累计）
        deltaInserted.add(l.msgId);
        out.push({ ...l, text: l.text || deltas.get(l.msgId)!.text });
        return;
      }
      out.push(l);
    });
    // 流式中途刷新：尚无最终行的 delta → 显示已生成的部分
    for (const [msgId, acc] of deltas) {
      if (finalSeen.has(msgId) || deltaInserted.has(msgId)) continue;
      out.push({ n: 0, ts: acc.ts, kind: "assistant", text: acc.text, msgId });
    }
    return out.sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? -1 : 1));
  }

  /** 归档会话（清除聊天记录的默认行为）。 */
  archive(sessionId: string): void {
    const idx = this.currentIndex;
    const s = idx.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    if (!s.archivedAt) s.archivedAt = new Date().toISOString();
    if (idx.activeId === sessionId) {
      idx.activeId = null;
      this.newSession("新对话");
      return;
    }
    this.saveIndex();
  }

  /** 打开（恢复）已归档会话：旧活动会话归档，目标会话恢复为活动。 */
  open(sessionId: string): void {
    const idx = this.currentIndex;
    const s = idx.sessions.find((x) => x.id === sessionId);
    if (!s) throw new Error("会话不存在");
    if (idx.activeId && idx.activeId !== sessionId) {
      const old = idx.sessions.find((x) => x.id === idx.activeId);
      if (old && !old.archivedAt) old.archivedAt = new Date().toISOString();
    }
    s.archivedAt = undefined;
    idx.activeId = sessionId;
    this.saveIndex();
  }

  /** 删除会话：默认归档语义的删除即 archive；permanent=true 永久删除文件（需前端二次确认）。 */
  deleteSession(sessionId: string, permanent: boolean): { deleted: boolean } {
    const idx = this.currentIndex;
    const s = idx.sessions.find((x) => x.id === sessionId);
    if (!s) return { deleted: false };
    if (!permanent) {
      this.archive(sessionId);
      return { deleted: true };
    }
    if (idx.activeId === sessionId) idx.activeId = null;
    idx.sessions = idx.sessions.filter((x) => x.id !== sessionId);
    this.saveIndex();
    try {
      fs.rmSync(this.fileOf(sessionId), { force: true });
    } catch {
      /* ignore */
    }
    info("session", `永久删除会话 ${sessionId}`);
    return { deleted: true };
  }

  /** 上下文占用（需求 9.3：占用估算 / 使用者填写的模型上下文上限）。 */
  contextUsage(sessionId: string, maxTokens: number): { tokens: number; percent: number; overThreshold: boolean; thresholdPercent: number } {
    const lines = this.read(sessionId);
    const chars = lines.map((l) => l.text).join("\n").length;
    const tokens = estimateTokens(lines.map((l) => l.text).join("\n")) || estimateTokens(" ".repeat(chars));
    const cfg = this.index ? Math.max(1, maxTokens) : maxTokens;
    const percent = Math.round((tokens / cfg) * 1000) / 10;
    const thresholdPercent = 70;
    return { tokens, percent, overThreshold: percent >= thresholdPercent, thresholdPercent };
  }

  /** 归档列表。 */
  listSessions(): SessionMeta[] {
    return [...this.currentIndex.sessions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * 上下文压缩（需求 9.3/L10）：把较早的行替换为一条摘要行，保留最近 keepRecent 行原文。
   * 只重写一次文件；调用方保证每轮对话最多调用 1 次（压缩本身不触发压缩）。
   * 返回压缩前后估算 token 数。
   */
  compact(sessionId: string, summaryText: string, keepRecent = 12): { before: number; after: number } {
    const lines = this.readRaw(sessionId);
    const before = estimateTokens(lines.map((l) => l.text).join("\n"));
    const kept = lines.slice(Math.max(0, lines.length - keepRecent));
    const out: ChatLine[] = [
      { n: 1, ts: new Date().toISOString(), kind: "summary", text: `【较早对话的摘要】${summaryText}` },
      { n: 2, ts: new Date().toISOString(), kind: "compact_notice", text: "已自动整理较早的对话" },
      ...kept.map((l, i) => ({ ...l, n: i + 3 })),
    ];
    this.writeRaw(sessionId, out);
    const after = estimateTokens(out.map((l) => l.text).join("\n"));
    info("session", `会话 ${sessionId} 已压缩：约 ${before} → ${after} tokens（保留最近 ${kept.length} 行）`);
    return { before, after };
  }

  /** 压缩后仍超阈值时的兜底（L10/V12）：直接截断最旧的 dropCount 行，不再调用大脑。 */
  truncateOldest(sessionId: string, dropCount: number): { dropped: number; after: number } {
    const lines = this.readRaw(sessionId);
    const drop = Math.min(dropCount, Math.max(0, lines.length - 2));
    const kept = lines.slice(drop).map((l, i) => ({ ...l, n: i + 1 }));
    this.writeRaw(sessionId, kept);
    const after = estimateTokens(kept.map((l) => l.text).join("\n"));
    warn("session", `压缩后仍超限，已截断最旧 ${drop} 行（不再递归压缩）`);
    return { dropped: drop, after };
  }

  /** 原始行读取（含 delta 行，按文件顺序）。 */
  private readRaw(sessionId: string): ChatLine[] {
    const file = this.fileOf(sessionId);
    if (!fs.existsSync(file)) return [];
    const lines: ChatLine[] = [];
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try {
        lines.push(JSON.parse(raw));
      } catch {
        /* 损坏行跳过 */
      }
    }
    return lines;
  }

  private writeRaw(sessionId: string, lines: ChatLine[]): void {
    const file = this.fileOf(sessionId);
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""), "utf8");
    fs.renameSync(tmp, file);
  }
}

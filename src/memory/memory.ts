/**
 * 记忆两层（需求 9.4/9.5）：文件即记忆，不做向量库。
 * - 项目记忆：.dispatch/memory/project.md —— 项目目标、已确认需求、技术决策、踩过的坑、验收经验。
 * - 全局记忆：~/.dispatch-center/memory/user.md —— 使用者偏好（语言、风格、权限偏好）。
 * - 条目格式：M<序号> [日期] (来源任务) 内容，一行一条；大脑输出结构化变更，程序校验后应用。
 * - 写入前做密钥脱敏扫描（记忆里不得保存密钥与令牌）；项目记忆上限 8KB，超出时由整理合并旧条目。
 * - 每个任务结束只触发 1 次记忆整理（L13），整理的产出不触发新的整理。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { globalMemoryFile, projectMemoryFile, projectDispatchDir } from "../util/paths";
import { redact, info } from "../logger";

export const PROJECT_MEMORY_MAX_BYTES = 8 * 1024; // 需求 9.5：项目记忆上限 8KB

export interface MemoryEntry {
  id: string; // M1、M2…
  date: string; // YYYY-MM-DD
  source?: string; // 来源任务 id
  text: string;
}

function parseMemory(content: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const raw of (content ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^-?\s*(M\d+)\s+\[([\d-]+)\](?:\s*\(([^)]*)\))?\s*(.+)$/);
    if (m) {
      entries.push({ id: m[1], date: m[2], source: m[3] || undefined, text: m[4] });
    } else if (line.startsWith("-")) {
      // 兼容自由格式行（使用者手写的条目）
      entries.push({ id: `M${entries.length + 1}-${Date.now().toString(36)}`, date: "", text: line.replace(/^-\s*/, "") });
    }
  }
  return entries;
}

function serializeMemory(entries: MemoryEntry[], title: string): string {
  const head = `# ${title}\n\n<!-- 每行一条：M<序号> [日期] (来源任务) 内容。可在此文件手动编辑。 -->\n`;
  return head + entries.map((e) => `- ${e.id} [${e.date}]${e.source ? ` (${e.source})` : ""} ${e.text}`).join("\n") + "\n";
}

export class MemoryStore {
  private projectDir = "";

  bindProject(projectDir: string): void {
    this.projectDir = projectDir;
    fs.mkdirSync(path.join(projectDispatchDir(projectDir), "memory"), { recursive: true });
  }

  /** 读取记忆（scope=project 项目记忆 / global 全局记忆）。 */
  read(scope: "project" | "global"): MemoryEntry[] {
    const file = scope === "project" ? projectMemoryFile(this.projectDir) : globalMemoryFile();
    try {
      return parseMemory(fs.readFileSync(file, "utf8"));
    } catch {
      return [];
    }
  }

  /** 记忆原文（供新会话载入，截取到上限，需求 9.5）。 */
  readRaw(scope: "project" | "global", maxBytes = 4000): string {
    const file = scope === "project" ? projectMemoryFile(this.projectDir) : globalMemoryFile();
    try {
      const c = fs.readFileSync(file, "utf8");
      const body = c.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("<!--")).join("\n");
      return body.slice(-maxBytes);
    } catch {
      return "";
    }
  }

  private fileOf(scope: "project" | "global"): string {
    return scope === "project" ? projectMemoryFile(this.projectDir) : globalMemoryFile();
  }

  private writeEntries(scope: "project" | "global", entries: MemoryEntry[]): { ok: boolean; error?: string } {
    // 密钥脱敏扫描（需求 9.5：记忆里不得保存密钥与令牌）
    for (const e of entries) e.text = redact(e.text);
    const content = serializeMemory(entries, scope === "project" ? "项目记忆" : "使用者偏好（全局记忆）");
    if (scope === "project" && Buffer.byteLength(content, "utf8") > PROJECT_MEMORY_MAX_BYTES) {
      // 超限：合并旧条目（保留最新的，旧的按序合并为一条摘要行）——程序侧兜底，正常由大脑整理步骤完成
      const keep = 40;
      const old = entries.slice(0, Math.max(0, entries.length - keep));
      const recent = entries.slice(-keep);
      if (old.length > 0) {
        const merged: MemoryEntry = {
          id: "M-old",
          date: old[0].date,
          text: `（更早记忆合并）${old.map((o) => o.text).join("；")}`.slice(0, 1500),
        };
        const content2 = serializeMemory([merged, ...recent], scope === "project" ? "项目记忆" : "使用者偏好（全局记忆）");
        if (Buffer.byteLength(content2, "utf8") > PROJECT_MEMORY_MAX_BYTES) {
          return { ok: false, error: "项目记忆超过 8KB 且合并后仍超限，请手动清理" };
        }
      } else {
        return { ok: false, error: "项目记忆超过 8KB，请手动清理" };
      }
    }
    const file = this.fileOf(scope);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 原子写
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, file);
    return { ok: true };
  }

  /** 应用大脑输出的结构化变更（L13；调用方保证每个任务只触发一次）。 */
  applyConsolidation(scope: "project" | "global", change: { add: string[]; update: { id: string; text: string }[]; delete: string[] }, sourceTaskId?: string): { ok: boolean; error?: string } {
    const entries = this.read(scope);
    for (const del of change.delete) {
      const i = entries.findIndex((e) => e.id === del);
      if (i >= 0) entries.splice(i, 1);
    }
    for (const u of change.update) {
      const e = entries.find((x) => x.id === u.id);
      if (e) e.text = u.text;
    }
    for (const add of change.add) {
      const nextNum = entries.length + 1;
      entries.push({
        id: `M${nextNum}${Date.now().toString(36).slice(-3)}`,
        date: new Date().toISOString().slice(0, 10),
        source: sourceTaskId,
        text: add,
      });
    }
    const r = this.writeEntries(scope, entries);
    if (r.ok) info("memory", `记忆整理完成(${scope}) add=${change.add.length} update=${change.update.length} delete=${change.delete.length}`);
    return r;
  }

  /** 使用者直接编辑/新增/删除（设置中心，需求 9.5）。 */
  editEntry(scope: "project" | "global", id: string | null, text: string | null): { ok: boolean; error?: string } {
    const entries = this.read(scope);
    if (id === null && text !== null) {
      entries.push({ id: `M${entries.length + 1}${Date.now().toString(36).slice(-3)}`, date: new Date().toISOString().slice(0, 10), text });
    } else if (id !== null && text !== null) {
      const e = entries.find((x) => x.id === id);
      if (!e) return { ok: false, error: "条目不存在" };
      e.text = text;
    } else if (id !== null && text === null) {
      const i = entries.findIndex((x) => x.id === id);
      if (i < 0) return { ok: false, error: "条目不存在" };
      entries.splice(i, 1);
    }
    return this.writeEntries(scope, entries);
  }
}

export const memory = new MemoryStore();

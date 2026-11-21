import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { dataDir, globalDir } from "./util/paths";

/**
 * 全局密钥登记：配置加载后把所有密钥值登记进来，
 * 任何写入日志/记忆/诊断包/发给大脑的字符串都先经过 redact() 脱敏
 * （需求 4.6/A9、9.5 记忆写入前密钥脱敏、16.4 发给大脑前脱敏、17 诊断包脱敏）。
 */
const secrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6 && value !== "在此填入你的 API Key") {
    secrets.add(value);
  }
}

/** 常见密钥形态的兜底正则（16.4：把项目文件内容发给大脑前对常见密钥格式脱敏）。 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g, // OpenAI 风格
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g, // AWS
  /xox[bpars]-[A-Za-z0-9-]{10,}/g, // Slack
  /glpat-[A-Za-z0-9_-]{15,}/g, // GitLab
  /Bearer\s+[A-Za-z0-9._-]{12,}/g,
];

/** 键值对形态（如 "apiKey": "xxxx" / api_key=xxxx）：保留键名，只遮盖值。 */
const SECRET_KV_PATTERN = /("?(api[_-]?key|apikey|secret|token|password|access[_-]?token|authorization)"?\s*[:=]\s*"?)([^"\s,;]{8,})/gi;

export function redact(text: string): string {
  let out = text ?? "";
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join("***REDACTED***");
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "***REDACTED***");
  }
  out = out.replace(SECRET_KV_PATTERN, (_m, prefix: string) => `${prefix}***REDACTED***`);
  return out;
}

export type LogLevel = "info" | "warn" | "error";

export const logBus = new EventEmitter();

function logFilePath(): string {
  const dir = path.join(dataDir(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return path.join(dir, `dispatch-${stamp}.log`);
}

/** 按天滚动的日志文件（需求 17）；保留 14 天由清理例程执行。 */
export function log(level: LogLevel, scope: string, message: string, taskId?: string, loopId?: string): void {
  const safe = redact(message);
  const withIds = [taskId ? `taskId=${taskId}` : "", loopId ? `loopId=${loopId}` : ""].filter(Boolean).join(" ");
  const line = `[${new Date().toISOString()}] [${level}] [${scope}]${withIds ? " [" + withIds + "]" : ""} ${safe}`;
  try {
    fs.appendFileSync(logFilePath(), line + "\n");
  } catch {
    /* 日志失败不影响主流程 */
  }
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  logBus.emit("entry", { ts: new Date().toISOString(), level, scope, message: safe });
}

export function info(scope: string, message: string, taskId?: string, loopId?: string): void {
  log("info", scope, message, taskId, loopId);
}
export function warn(scope: string, message: string, taskId?: string, loopId?: string): void {
  log("warn", scope, message, taskId, loopId);
}
export function error(scope: string, message: string, taskId?: string, loopId?: string): void {
  log("error", scope, message, taskId, loopId);
}

/** 启动时清理 14 天前的日志文件（需求 17：全局日志按天滚动，保留 14 天）。 */
export function pruneOldLogs(days = 14): void {
  const dir = path.join(dataDir(), "logs");
  try {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith("dispatch-") && f.endsWith(".log"));
    const cutoff = Date.now() - days * 86400000;
    for (const f of files) {
      const full = path.join(dir, f);
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
    }
  } catch {
    /* 忽略 */
  }
}

/** 供诊断包读取最近日志（已脱敏）。 */
export function readRecentLogs(lines = 400): string[] {
  try {
    const file = logFilePath();
    if (!fs.existsSync(file)) return [];
    const all = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

/** 全局目录初始化（memory/ 等）。 */
export function ensureGlobalDirs(): void {
  fs.mkdirSync(path.join(globalDir(), "memory"), { recursive: true });
  fs.mkdirSync(dataDir(), { recursive: true });
}

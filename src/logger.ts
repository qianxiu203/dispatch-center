import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { dataDir } from "./util/paths";

/**
 * 全局密钥登记：配置加载后把所有密钥值登记进来，
 * 任何写入日志的字符串都会先经过 redact() 脱敏（需求 4.6 / A9）。
 */
const secrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6 && value !== "在此填入你的 API Key") {
    secrets.add(value);
  }
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join("***REDACTED***");
  }
  // 兜底：常见密钥字段的值一律脱敏
  out = out.replace(
    /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/g,
    "***REDACTED***"
  );
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

export function log(level: LogLevel, scope: string, message: string): void {
  const safe = redact(message);
  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${safe}`;
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

export function info(scope: string, message: string): void {
  log("info", scope, message);
}
export function warn(scope: string, message: string): void {
  log("warn", scope, message);
}
export function error(scope: string, message: string): void {
  log("error", scope, message);
}

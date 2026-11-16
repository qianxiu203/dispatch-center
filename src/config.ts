import * as fs from "node:fs";
import * as path from "node:path";
import { appRoot, dataDir } from "./util/paths";
import { registerSecret, warn } from "./logger";

/**
 * 配置模块：唯一来源是程序目录下的 config.json（含密钥，已被 .gitignore 排除）。
 * config.example.json 是占位模板。
 */
export interface BrainConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface WorkerConfig {
  kind: string; // 第一期固定 "codex"
  executablePath: string; // 留空则用 PATH 里的 codex / codex.cmd
  baseUrl: string; // 留空则使用工人自己的登录配置
  model: string;
  apiKey: string; // 留空则使用工人自己的登录配置
}

export interface LimitsConfig {
  maxFixAttempts: number; // 同一错误连续修复上限，需求默认 3
  maxStepsPerTask: number;
  maxMinutesPerTask: number;
}

export interface AcceptanceConfig {
  commandTimeoutSeconds: number;
}

export interface AppConfig {
  port: number;
  host: string; // 只监听本机（需求 3.4）
  brain: BrainConfig;
  worker: WorkerConfig;
  permissionMode: "yolo" | "graded";
  limits: LimitsConfig;
  acceptance: AcceptanceConfig;
}

const DEFAULTS: AppConfig = {
  port: 3210,
  host: "127.0.0.1",
  brain: { baseUrl: "", apiKey: "", model: "" },
  worker: { kind: "codex", executablePath: "", baseUrl: "", model: "", apiKey: "" },
  permissionMode: "yolo",
  limits: { maxFixAttempts: 3, maxStepsPerTask: 30, maxMinutesPerTask: 60 },
  acceptance: { commandTimeoutSeconds: 120 },
};

export function configPath(): string {
  return path.join(appRoot(), "config.json");
}

let current: AppConfig = JSON.parse(JSON.stringify(DEFAULTS));

export function getConfig(): AppConfig {
  return current;
}

/** 深合并 patch 到默认配置，登记密钥用于日志脱敏。 */
function mergeInto(base: any, patch: any): any {
  if (patch === null || patch === undefined) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return patch;
  const out: any = { ...base };
  for (const k of Object.keys(patch)) {
    out[k] = mergeInto(base[k], patch[k]);
  }
  return out;
}

export function loadConfig(): AppConfig {
  const p = configPath();
  if (fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      current = mergeInto(DEFAULTS, raw) as AppConfig;
    } catch (e: any) {
      warn("config", `config.json 解析失败，使用默认配置: ${e.message}`);
      current = JSON.parse(JSON.stringify(DEFAULTS));
    }
  } else {
    current = JSON.parse(JSON.stringify(DEFAULTS));
  }
  registerSecret(current.brain.apiKey);
  registerSecret(current.worker.apiKey);
  return current;
}

export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  current = mergeInto(current, patch) as AppConfig;
  registerSecret(current.brain.apiKey);
  registerSecret(current.worker.apiKey);
  fs.writeFileSync(configPath(), JSON.stringify(current, null, 2), "utf8");
  return current;
}

/** 对外暴露的配置视图：密钥不回传前端。 */
export function sanitizedConfig(): Record<string, unknown> {
  const c = current;
  return {
    port: c.port,
    host: c.host,
    brain: { baseUrl: c.brain.baseUrl, model: c.brain.model, apiKeySet: !!c.brain.apiKey && c.brain.apiKey !== "在此填入你的 API Key" },
    worker: {
      kind: c.worker.kind,
      executablePath: c.worker.executablePath,
      baseUrl: c.worker.baseUrl,
      model: c.worker.model,
      apiKeySet: !!c.worker.apiKey,
    },
    permissionMode: c.permissionMode,
    limits: c.limits,
    acceptance: c.acceptance,
  };
}

/** 当前项目列表持久化在 data/projects.json（运行时数据）。 */
export interface ProjectEntry {
  path: string;
  name: string;
}

export function loadProjects(): ProjectEntry[] {
  const p = path.join(dataDir(), "projects.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

export function saveProjects(list: ProjectEntry[]): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(path.join(dataDir(), "projects.json"), JSON.stringify(list, null, 2), "utf8");
}

/** 仅供自动化测试：只在内存中覆盖配置，不写 config.json 文件。 */
export function setConfigForTest(patch: Partial<AppConfig>): void {
  current = mergeInto(current, patch) as AppConfig;
  registerSecret(current.brain.apiKey);
  registerSecret(current.worker.apiKey);
}

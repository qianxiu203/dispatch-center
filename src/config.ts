import * as fs from "node:fs";
import * as path from "node:path";
import { appRoot, dataDir } from "./util/paths";
import { registerSecret, warn } from "./logger";

/**
 * 配置模块：唯一来源是程序目录下的 config.json（含密钥，已被 .gitignore 排除）。
 * config.example.json 是占位模板。v2 新增默认值均来自需求文档第 20 节的默认设定。
 */

export interface BrainConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 模型上下文长度（需求 9.3：由使用者在设置里填写，默认保守取 32k，不按模型名猜）。 */
  maxContextTokens: number;
  /** 自动压缩阈值（需求 9.3：占用达到上限的 70% 触发，L10）。 */
  compressThreshold: number;
}

export interface WorkerConfig {
  kind: string; // v2 仍固定 "codex"
  executablePath: string; // 留空则用 PATH 里的 codex / codex.cmd
  baseUrl: string; // 留空则使用工人自己的登录配置
  model: string;
  apiKey: string; // 留空则使用工人自己的登录配置
  /**
   * 危险全权模式（需求 15.4）：默认 false。开启后工人用 -s danger-full-access 运行
   * （官方文档：无沙箱、无审批）。调度中心在该模式下不具备执行前拦截能力，
   * 设置界面与 README 如实标注，需使用者自行确认风险。
   */
  dangerFullAccess: boolean;
  /** workspace-write 沙箱内是否放行网络（官方默认关；工人安装依赖需要联网，默认放行）。 */
  sandboxNetworkAccess: boolean;
}

/** 看门狗默认值（需求 4.1-M6 / 20.1）：不允许设为「无限」。 */
export interface WatchdogConfig {
  maxTotalMinutes: number; // 任务总时长，默认 90 分钟
  maxWorkerCalls: number; // 工人调用总次数，默认 40
  maxSilenceMinutes: number; // 静默时长（没有任何工人输出或事件），默认 10 分钟
  maxBrainCalls: number; // 大模型调用总次数，默认 200
}

export interface LimitsConfig {
  /** 兼容一期字段：同一错误连续修复上限（等价于 L1 的 maxPerSignature）。 */
  maxFixAttempts: number;
  maxStepsPerTask: number;
  maxMinutesPerTask: number;
  /** L1 验收→修复循环（需求 20.2：同一问题最多修复 3 次，单任务总修复 6 次）。 */
  maxFixPerSignature: number;
  maxTotalFixes: number;
  /** 工人提问上限（L4：单任务内工人提问最多 15 次）。 */
  maxWorkerQuestions: number;
  /** 验收标准生成重试上限（L2：不合格让大脑重新生成最多 2 次）。 */
  maxCriteriaRegen: number;
  /** 调度侧缺陷的重新生成上限（L3：最多触发 1 次）。 */
  maxHarnessRegen: number;
}

export interface HeartbeatConfig {
  /** 心跳间隔分钟（L8：1 到 60 分钟，不允许 0 或无间隔）。 */
  intervalMinutes: number;
}

export interface AcceptanceConfig {
  commandTimeoutSeconds: number;
}

export interface EnvConfig {
  /** Playwright 二进制国内镜像（需求 11.2，可在设置中心修改）。 */
  mirrorDownloadHost: string;
}

export interface AppConfig {
  port: number;
  host: string; // 只监听本机（需求 2.5）
  brain: BrainConfig;
  worker: WorkerConfig;
  permissionMode: "yolo" | "graded";
  limits: LimitsConfig;
  watchdog: WatchdogConfig;
  heartbeat: HeartbeatConfig;
  acceptance: AcceptanceConfig;
  env: EnvConfig;
}

const DEFAULTS: AppConfig = {
  port: 3210,
  host: "127.0.0.1",
  brain: { baseUrl: "", apiKey: "", model: "", maxContextTokens: 32768, compressThreshold: 0.7 },
  worker: { kind: "codex", executablePath: "", baseUrl: "", model: "", apiKey: "", dangerFullAccess: false, sandboxNetworkAccess: true },
  permissionMode: "yolo",
  limits: {
    maxFixAttempts: 3,
    maxStepsPerTask: 30,
    maxMinutesPerTask: 60,
    maxFixPerSignature: 3,
    maxTotalFixes: 6,
    maxWorkerQuestions: 15,
    maxCriteriaRegen: 2,
    maxHarnessRegen: 1,
  },
  watchdog: { maxTotalMinutes: 90, maxWorkerCalls: 40, maxSilenceMinutes: 10, maxBrainCalls: 200 },
  heartbeat: { intervalMinutes: 5 },
  acceptance: { commandTimeoutSeconds: 120 },
  env: { mirrorDownloadHost: "https://cdn.npmmirror.com/binaries/playwright" },
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

/** 看门狗等上限的取值保护（需求 M6：不允许设为「无限」/ 0）。 */
function clampConfig(c: AppConfig): AppConfig {
  const clampNum = (v: any, min: number, max: number, fallback: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  };
  c.limits.maxFixPerSignature = clampNum(c.limits.maxFixPerSignature, 1, 20, DEFAULTS.limits.maxFixPerSignature);
  c.limits.maxTotalFixes = clampNum(c.limits.maxTotalFixes, 1, 50, DEFAULTS.limits.maxTotalFixes);
  c.limits.maxWorkerQuestions = clampNum(c.limits.maxWorkerQuestions, 1, 100, DEFAULTS.limits.maxWorkerQuestions);
  c.limits.maxCriteriaRegen = clampNum(c.limits.maxCriteriaRegen, 0, 5, DEFAULTS.limits.maxCriteriaRegen);
  c.limits.maxHarnessRegen = clampNum(c.limits.maxHarnessRegen, 0, 3, DEFAULTS.limits.maxHarnessRegen);
  c.limits.maxStepsPerTask = clampNum(c.limits.maxStepsPerTask, 1, 200, DEFAULTS.limits.maxStepsPerTask);
  c.limits.maxMinutesPerTask = clampNum(c.limits.maxMinutesPerTask, 1, 24 * 60, DEFAULTS.limits.maxMinutesPerTask);
  c.watchdog.maxTotalMinutes = clampNum(c.watchdog.maxTotalMinutes, 1, 24 * 60, DEFAULTS.watchdog.maxTotalMinutes);
  c.watchdog.maxWorkerCalls = clampNum(c.watchdog.maxWorkerCalls, 1, 10000, DEFAULTS.watchdog.maxWorkerCalls);
  c.watchdog.maxSilenceMinutes = clampNum(c.watchdog.maxSilenceMinutes, 1, 240, DEFAULTS.watchdog.maxSilenceMinutes);
  c.watchdog.maxBrainCalls = clampNum(c.watchdog.maxBrainCalls, 1, 100000, DEFAULTS.watchdog.maxBrainCalls);
  c.heartbeat.intervalMinutes = clampNum(c.heartbeat.intervalMinutes, 1, 60, DEFAULTS.heartbeat.intervalMinutes);
  c.brain.maxContextTokens = clampNum(c.brain.maxContextTokens, 1000, 10_000_000, DEFAULTS.brain.maxContextTokens);
  c.brain.compressThreshold = Math.max(0.3, Math.min(0.95, Number(c.brain.compressThreshold) || DEFAULTS.brain.compressThreshold));
  c.brain.compressThreshold = Math.min(0.95, Math.max(0.3, c.brain.compressThreshold));
  return c;
}

export function loadConfig(): AppConfig {
  const p = configPath();
  if (fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      current = clampConfig(mergeInto(DEFAULTS, raw) as AppConfig);
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
  current = clampConfig(mergeInto(current, patch) as AppConfig);
  registerSecret(current.brain.apiKey);
  registerSecret(current.worker.apiKey);
  fs.writeFileSync(configPath(), JSON.stringify(current, null, 2), "utf8");
  return current;
}

/** 对外暴露的配置视图：密钥只显示末 4 位（需求 16.3）。 */
export function sanitizedConfig(): Record<string, unknown> {
  const c = current;
  const keyTail = (k: string) => (k ? `…${k.slice(-4)}` : "");
  return {
    port: c.port,
    host: c.host,
    brain: {
      baseUrl: c.brain.baseUrl,
      model: c.brain.model,
      apiKeyTail: keyTail(c.brain.apiKey),
      apiKeySet: !!c.brain.apiKey && c.brain.apiKey !== "在此填入你的 API Key",
      maxContextTokens: c.brain.maxContextTokens,
      compressThreshold: c.brain.compressThreshold,
    },
    worker: {
      kind: c.worker.kind,
      executablePath: c.worker.executablePath,
      baseUrl: c.worker.baseUrl,
      model: c.worker.model,
      apiKeyTail: keyTail(c.worker.apiKey),
      apiKeySet: !!c.worker.apiKey,
      dangerFullAccess: c.worker.dangerFullAccess,
      sandboxNetworkAccess: c.worker.sandboxNetworkAccess,
    },
    permissionMode: c.permissionMode,
    limits: c.limits,
    watchdog: c.watchdog,
    heartbeat: c.heartbeat,
    acceptance: c.acceptance,
    env: c.env,
  };
}

/** 当前项目列表持久化在 data/projects.json（运行时数据，需求 5.1 全局目录）。 */
export interface ProjectEntry {
  path: string;
  name: string;
  /** 项目开发服务的启动命令（需求 8.5：验收需要服务运行时使用）。 */
  startCommand?: string;
  createdAt: string;
}

export function loadProjects(): ProjectEntry[] {
  const p = path.join(dataDir(), "projects.json");
  try {
    const list = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(list) ? list : [];
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
  current = clampConfig(mergeInto(current, patch) as AppConfig);
  registerSecret(current.brain.apiKey);
  registerSecret(current.worker.apiKey);
}

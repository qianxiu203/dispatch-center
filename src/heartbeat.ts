/**
 * 心跳检测（需求 10 / L8）：
 * - 固定间隔（默认 5 分钟，可设 1~60 分钟，不允许 0 或无间隔）。
 * - 检测项：工人 CLI 可执行（版本命令，超时 10 秒）；工人登录状态（`codex login status`，
 *   依据 2026-11-20 本机 codex-cli 0.169.0 `codex login --help` 实测存在该子命令，
 *   说明原文 "Show login status"，未登录输出 "Not logged in" 退出码 1）；大脑接口可达
 *   （最小请求 GET /models，绝不发完整对话）；磁盘剩余空间（低于 1GB 警告）；浏览器可用。
 * - 只记录状态与通知：由正常变异常的那一刻通知一次，同一异常 30 分钟内不重复通知；
 *   心跳绝不自动重启工人，也不唤醒大脑。
 * - 检测失败时若有运行中任务，不自动中断任务，只提示（需求 10.3）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir, toolsDir } from "./util/paths";
import { runCmd } from "./envcheck/check";
import { getConfig } from "./config";
import { publish } from "./events";
import { info } from "./logger";

export interface HeartbeatItem {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
  checkedAt: string;
}

export interface HeartbeatRecord {
  ts: string;
  dot: "green" | "yellow" | "red";
  items: HeartbeatItem[];
}

const HISTORY_MAX = 100; // 需求 10.2：保留最近 100 条历史

function historyFile(): string {
  return path.join(dataDir(), "heartbeat.json");
}

function loadHistory(): HeartbeatRecord[] {
  try {
    return JSON.parse(fs.readFileSync(historyFile(), "utf8"));
  } catch {
    return [];
  }
}

function saveHistory(h: HeartbeatRecord[]): void {
  fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
  fs.writeFileSync(historyFile(), JSON.stringify(h.slice(-HISTORY_MAX), null, 2), "utf8");
}

/** 工人 CLI 可执行文件（与 codex 适配器同一探测顺序）。 */
function codexExecutable(): string {
  const cfg = getConfig().worker;
  if (cfg.executablePath) return cfg.executablePath;
  const portableBin = path.join(toolsDir(), "npm", "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
  if (fs.existsSync(portableBin)) return portableBin;
  return process.platform === "win32" ? "codex.cmd" : "codex";
}

/** 磁盘剩余空间（字节）。 */
async function diskFreeBytes(dir: string): Promise<number | null> {
  try {
    const st = (fs as any).statfs ? await (fs.promises as any).statfs(dir) : null;
    return st ? st.bsize * st.bavail : null;
  } catch {
    return null;
  }
}

/** 大脑接口可达：最小请求 GET {base}/models（需求 10.1：不得每次发完整对话）。 */
async function brainReachable(): Promise<{ ok: boolean; detail: string }> {
  const cfg = getConfig();
  if (!cfg.brain.baseUrl) return { ok: false, detail: "未配置大脑接口地址" };
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    const url = cfg.brain.baseUrl.replace(/\/+$/, "") + "/models";
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.brain.apiKey}` }, signal: controller.signal });
    clearTimeout(t);
    if (res.ok) return { ok: true, detail: `大脑接口可达（HTTP ${res.status}）` };
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `大脑接口认证失败（HTTP ${res.status}）` };
    return { ok: true, detail: `大脑接口可达（HTTP ${res.status}）` }; // 404/405 等说明网络通，只是路径不同
  } catch (e: any) {
    return { ok: false, detail: `大脑接口不可达: ${String(e?.message ?? e).slice(0, 120)}` };
  }
}

async function browserAvailable(): Promise<{ ok: boolean; detail: string }> {
  try {
    const pw = require("playwright");
    const exe = pw.chromium.executablePath();
    if (exe && fs.existsSync(exe)) return { ok: true, detail: "Chromium 就绪" };
    // 回退：系统 Edge / Chrome（需求 11.2 第 1 顺位）
    for (const channel of ["msedge", "chrome"]) {
      try {
        const p = pw.chromium.executablePath(channel as any);
        if (p && fs.existsSync(p)) return { ok: true, detail: `使用系统 ${channel === "msedge" ? "Edge" : "Chrome"}` };
      } catch {
        /* 该 channel 不存在 */
      }
    }
    return { ok: false, detail: "Chromium 未下载（可在环境体检一键安装）" };
  } catch {
    return { ok: false, detail: "Playwright 未安装" };
  }
}

export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private lastRunAt = 0;
  private lastAbnormalNotifiedAt = 0;
  private lastDot: "green" | "yellow" | "red" = "green";
  private running = false;

  start(): void {
    if (this.timer) return;
    const min = Math.max(1, Math.min(60, getConfig().heartbeat.intervalMinutes)) * 60000;
    this.timer = setInterval(() => {
      void this.run();
    }, min);
    this.timer.unref?.();
    info("heartbeat", `心跳已启动，间隔 ${min / 60000} 分钟`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  history(): HeartbeatRecord[] {
    return loadHistory();
  }

  /** 立即检测（需求 10.2：10 秒冷却）。 */
  async runNow(): Promise<{ ok: boolean; detail: string; record?: HeartbeatRecord }> {
    if (Date.now() - this.lastRunAt < 10000) {
      return { ok: false, detail: "检测过于频繁，请 10 秒后再试" };
    }
    const rec = await this.run();
    return { ok: true, detail: "检测完成", record: rec };
  }

  /** 执行一轮检测；只记录与通知（L8）。 */
  async run(): Promise<HeartbeatRecord> {
    if (this.running) return this.lastRecord() ?? { ts: new Date().toISOString(), dot: "green", items: [] };
    this.running = true;
    this.lastRunAt = Date.now();
    const items: HeartbeatItem[] = [];
    const checkedAt = new Date().toISOString();

    // 1) 工人 CLI 可执行（超时 10 秒）
    try {
      const r = await runCmd(codexExecutable(), ["--version"], 10000);
      items.push({ id: "worker_cli", name: "工人 CLI（codex）", ok: r.code === 0, detail: r.code === 0 ? `codex ${r.out.split("\n")[0]} 可用` : "codex 不可执行（可在环境体检安装）", checkedAt });
    } catch (e: any) {
      items.push({ id: "worker_cli", name: "工人 CLI（codex）", ok: false, detail: `检测失败: ${e.message}`, checkedAt });
    }

    // 2) 工人登录状态（最轻量方式：codex login status，依据见文件头）
    try {
      const r = await runCmd(codexExecutable(), ["login", "status"], 10000);
      const logged = r.code === 0;
      // 用中转 baseUrl/apiKey 的部署不走官方登录，此检测仅提示，不判红
      const usingRelay = !!getConfig().worker.baseUrl;
      items.push({
        id: "worker_login",
        name: "工人登录状态",
        ok: true,
        detail: logged ? "已登录" : usingRelay ? "官方未登录（使用中转配置，不影响）" : "登录状态未验证或未登录（如工人报认证错误请在终端运行 codex login）",
        checkedAt,
      });
    } catch (e: any) {
      items.push({ id: "worker_login", name: "工人登录状态", ok: true, detail: `登录状态未验证: ${String(e.message).slice(0, 80)}`, checkedAt });
    }

    // 3) 大脑接口可达（最小请求）
    {
      const r = await brainReachable();
      items.push({ id: "brain", name: "大脑接口", ok: r.ok, detail: r.detail, checkedAt });
    }

    // 4) 磁盘剩余空间（低于 1GB 警告）
    {
      const free = await diskFreeBytes(dataDir());
      if (free === null) {
        items.push({ id: "disk", name: "磁盘空间", ok: true, detail: "无法检测（跳过）", checkedAt });
      } else {
        const gb = free / 1024 ** 3;
        items.push({ id: "disk", name: "磁盘空间", ok: gb >= 1, detail: `剩余 ${gb.toFixed(1)} GB${gb < 1 ? "（低于 1GB，请清理）" : ""}`, checkedAt });
      }
    }

    // 5) 浏览器可用
    {
      const r = await browserAvailable();
      items.push({ id: "browser", name: "验收浏览器", ok: r.ok, detail: r.detail, checkedAt });
    }

    // 汇总状态点：核心项（工人 CLI、大脑、浏览器）任一失败 → 红；非核心失败 → 黄
    const coreFail = items.filter((i) => ["worker_cli", "brain", "browser"].includes(i.id) && !i.ok);
    const otherFail = items.filter((i) => !["worker_cli", "brain", "browser"].includes(i.id) && !i.ok);
    const dot: "green" | "yellow" | "red" = coreFail.length > 0 ? "red" : otherFail.length > 0 ? "yellow" : "green";
    const rec: HeartbeatRecord = { ts: checkedAt, dot, items };

    // 保存历史（最近 100 条）
    const hist = loadHistory();
    hist.push(rec);
    saveHistory(hist);

    // 由正常变异常的那一刻通知一次；同一异常 30 分钟内不重复（L8）
    if (dot !== "green" && (this.lastDot === "green" || Date.now() - this.lastAbnormalNotifiedAt > 30 * 60000)) {
      this.lastAbnormalNotifiedAt = Date.now();
      const bad = items.filter((i) => !i.ok).map((i) => `${i.name}：${i.detail}`).join("；");
      publish({ type: "notice", level: "warn", text: `系统状态异常（${dot === "red" ? "红" : "黄"}）：${bad}。检测失败不影响运行中的任务，详情见设置中心「系统状态」。` });
    }
    if (dot !== this.lastDot || dot !== "green") {
      publish({ type: "heartbeat", dot, summary: items.map((i) => `${i.ok ? "✓" : "✗"}${i.name}`).join(" "), items });
    }
    this.lastDot = dot;
    this.running = false;
    return rec;
  }

  lastRecord(): HeartbeatRecord | undefined {
    const h = loadHistory();
    return h[h.length - 1];
  }

  /** 左栏状态点。 */
  dot(): "green" | "yellow" | "red" {
    return this.lastDot;
  }
}

export const heartbeat = new Heartbeat();

/**
 * 环境体检 + 一键修复 v2（需求 11 / L7 / V9）：
 * - 体检项：Node、Git、Git Bash（win）、工人 CLI、浏览器、网络（到大脑接口、到镜像）、磁盘空间。
 * - 浏览器获取固定顺序（需求 11.2）：
 *   ① 系统已装的 Edge / Chrome（Playwright channel 方式调用）；
 *   ② Playwright Chromium 经国内镜像下载（config.env.mirrorDownloadHost，实测
 *      https://cdn.npmmirror.com/binaries/playwright/<官方路径> 可用）；
 *   ③ Playwright Chromium 经官方源下载（playwright --dry-run 输出的官方 URL）。
 *   每一步失败都记录原因再走下一步（L7）。
 * - 进度（需求 11.3）：步骤名、百分比或已下载字节数与速度、取消按钮、可折叠日志；
 *   60 秒没有任何进度更新判定卡住，自动中断并记为一次失败。
 * - 安装位置：全部装进调度中心 tools 目录，便携不污染系统，无需管理员权限。
 * - codex CLI：npm 安装到 tools/npm（包名 @openai/codex，依据一期实测 npm view bin=codex.js）。
 * - Git(Windows)：MinGit 便携包解压到 tools/MinGit（不运行安装器）。
 */
import { execFile, spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as http from "node:http";
import * as path from "node:path";
import { toolsDir } from "../util/paths";
import { info, error as logError } from "../logger";
import { getConfig } from "../config";
import { publish } from "../events";

export interface CheckResult {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
  version?: string;
  fixable: boolean;
  fixDescription?: string;
}

/**
 * 运行外部命令，永远 resolve、绝不 reject：任何失败（含 spawn 同步抛错）都以
 * { code: 1, out: 错误信息 } 返回。Windows 上 npm/npx/codex 都是 .cmd 启动器，
 * Node 20.12+（CVE-2024-27980 安全策略）禁止不经 shell 直接启动 .bat/.cmd，
 * 因此 win32 统一走 shell，并把含空格的参数手工加引号（与 src/worker/codex.ts 一致）。
 */
export function runCmd(cmd: string, args: string[], timeout = 15000, extraEnv?: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const file = isWin ? joinShellCommand(cmd, args) : cmd;
    const argv = isWin ? [] : args;
    try {
      execFile(
        file,
        argv,
        { timeout, windowsHide: true, shell: isWin, env: { ...process.env, ...extraEnv } },
        (err, stdout, stderr) => {
          const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
          resolve({ code, out: `${stdout}${stderr}`.trim() });
        }
      );
    } catch (err: any) {
      resolve({ code: 1, out: err?.message ?? String(err) });
    }
  });
}

/** Windows shell 模式下把 exe 与参数拼成一条命令行，含空格的部分加引号。 */
function joinShellCommand(exe: string, args: string[]): string {
  const q = (a: string) => (/\s/.test(a) && !/^".*"$/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return [exe, ...args].map(q).join(" ");
}

/** 服务启动时应调用：把 Playwright 浏览器目录固定到调度中心 tools 下（便携）。 */
export function ensurePortableBrowserEnv(): void {
  const dir = path.join(toolsDir(), "playwright-browsers");
  fs.mkdirSync(dir, { recursive: true });
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = dir;
  }
}

function codexExecutable(): string {
  const configured = getConfig().worker.executablePath.trim();
  if (configured) return configured;
  const portableBin = path.join(toolsDir(), "npm", "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
  if (fs.existsSync(portableBin)) return portableBin;
  return process.platform === "win32" ? "codex.cmd" : "codex";
}

/** 逐项体检（需求 11.1）。 */
export async function runEnvCheck(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Node（>=18）
  {
    const r = await runCmd(process.execPath, ["--version"]);
    const v = r.out;
    const major = parseInt(v.replace(/^v/, ""), 10);
    results.push({
      id: "node",
      name: "Node.js",
      ok: r.code === 0 && major >= 18,
      detail: r.code === 0 ? (major >= 18 ? `Node ${v} 可用` : `Node ${v} 过旧，需要 >= 18`) : "Node.js 不可用",
      version: v,
      fixable: false,
      fixDescription: "调度中心本身依赖 Node 运行，请先安装 Node.js 18+ 后再启动。",
    });
  }

  // Git
  {
    const r = await runCmd("git", ["--version"]);
    const v = r.out;
    results.push({
      id: "git",
      name: "Git",
      ok: r.code === 0,
      detail: r.code === 0 ? `${v} 可用` : "Git 未安装（任务快照/回滚需要）",
      version: v,
      fixable: process.platform === "win32",
      fixDescription:
        process.platform === "win32"
          ? "将下载 MinGit 便携版到调度中心目录 tools\\MinGit，不写入系统注册表。"
          : "Linux 上请用系统包管理器安装（如 apt install git）。",
    });
  }

  // Git Bash（Windows 才检查）
  if (process.platform === "win32") {
    const r = await runCmd("bash", ["--version"], 8000);
    results.push({
      id: "gitbash",
      name: "Git Bash",
      ok: r.code === 0,
      detail: r.code === 0 ? "Git Bash 可用（start.sh 可在此运行）" : "未找到 Git Bash（建议安装 Git for Windows）",
      fixable: false,
      fixDescription: "安装 Git for Windows 后即带 Git Bash；调度中心 v2 的启动脚本 start.sh 可直接在 Git Bash 里运行。",
    });
  }

  // 工人 CLI：codex
  {
    const configured = getConfig().worker.executablePath.trim();
    const exe = codexExecutable();
    const r = await runCmd(exe, ["--version"]);
    results.push({
      id: "codex",
      name: "工人 CLI（codex）",
      ok: r.code === 0,
      detail: r.code === 0
        ? `codex ${r.out.split("\n")[0]} 可用${configured ? "（使用配置路径）" : ""}`
        : configured
          ? `配置的工人路径不可用: ${configured}（可在设置中心清空以自动探测，或一键修复）`
          : "codex CLI 未找到或不可用（工人执行需要）",
      version: r.code === 0 ? r.out.split("\n")[0] : undefined,
      fixable: true,
      fixDescription: "将用 npm 把 @openai/codex 安装到调度中心目录 tools\\npm（便携，不改系统全局）。",
    });
  }

  // 浏览器：优先系统 Edge/Chrome，其次 Playwright Chromium
  {
    let systemChannel: string | null = null;
    let pwInstalled = false;
    let chromiumOk = false;
    let version = "";
    try {
      const pw = require("playwright");
      pwInstalled = true;
      version = require("playwright/package.json").version;
      for (const channel of ["msedge", "chrome"]) {
        try {
          const p = pw.chromium.executablePath(channel as any);
          if (p && fs.existsSync(p)) {
            systemChannel = channel;
            break;
          }
        } catch {
          /* channel 不存在 */
        }
      }
      const exePath = pw.chromium.executablePath();
      chromiumOk = !!exePath && fs.existsSync(exePath);
    } catch {
      pwInstalled = false;
    }
    const ok = (pwInstalled && chromiumOk) || !!systemChannel;
    results.push({
      id: "chromium",
      name: "验收浏览器",
      ok,
      detail: systemChannel
        ? `使用系统已装浏览器（${systemChannel === "msedge" ? "Edge" : "Chrome"}）`
        : !pwInstalled
          ? "Playwright 库未安装（npm install 应已包含，若缺失请重新安装依赖）"
          : chromiumOk
            ? `Playwright ${version}，Chromium 已就绪`
            : `Playwright ${version} 已安装，但 Chromium 浏览器未下载`,
      version: version || undefined,
      fixable: pwInstalled && !chromiumOk && !systemChannel,
      fixDescription: "按顺序尝试：系统 Edge/Chrome → 国内镜像下载 Chromium → 官方源下载（装到调度中心 tools 目录）。",
    });
  }

  // 网络：到镜像与到大脑接口
  {
    const mirror = getConfig().env.mirrorDownloadHost;
    const netOk = await probeHttp(mirror);
    results.push({
      id: "network",
      name: "网络（下载镜像）",
      ok: netOk,
      detail: netOk ? `镜像可达: ${mirror}` : `镜像不可达: ${mirror}（可安装仍会尝试官方源）`,
      fixable: false,
    });
  }

  // 磁盘空间
  {
    let gb: number | null = null;
    try {
      const st = (fs as any).statfs ? await (fs.promises as any).statfs(toolsDir()) : null;
      if (st) gb = (st.bsize * st.bavail) / 1024 ** 3;
    } catch {
      /* 不支持则跳过 */
    }
    results.push({
      id: "disk",
      name: "磁盘空间",
      ok: gb === null || gb >= 1,
      detail: gb === null ? "无法检测（跳过）" : `剩余 ${gb.toFixed(1)} GB${gb < 1 ? "（低于 1GB，请清理）" : ""}`,
      fixable: false,
    });
  }

  return results;
}

function probeHttp(url: string, timeout = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const mod = url.startsWith("https:") ? https : http;
      const req = mod.get(url, { method: "HEAD" } as any, (res) => {
        resolve(!!res.statusCode && res.statusCode < 500);
        res.resume();
      });
      req.on("error", () => resolve(false));
      req.setTimeout(timeout, () => {
        req.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

// ───────────────────────── 一键修复（带进度与取消） ─────────────────────────

export interface InstallHandle {
  id: string;
  tool: string;
  promise: Promise<{ ok: boolean; detail: string }>;
  cancel: () => void;
}

const activeInstalls = new Map<string, InstallHandle>();
let installSeq = 0;

/** 取消进行中的安装（需求 11.3 取消按钮）。 */
export function cancelInstall(installId: string): boolean {
  const h = activeInstalls.get(installId);
  if (!h) return false;
  h.cancel();
  return true;
}

export function activeInstallIds(): string[] {
  return [...activeInstalls.keys()];
}

interface Progress {
  (p: { step: string; percent?: number; bytes?: number; speedBps?: number; log?: string }): void;
}

/**
 * 下载文件：字节进度 + 速度；无进度超时判定卡住并中断（需求 11.3 / L7，V9）。
 * 默认 60 秒没有任何进度更新即中断；无进度窗口可用环境变量
 * DISPATCH_DOWNLOAD_NOPROGRESS_MS 调小（供自动化测试注入「无进度」故障，生产不受影响）。
 */
export function downloadFile(url: string, dest: string, onProgress: Progress, step: string, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let redirects = 3;
    const attempt = (target: string) => {
      if (cancelled()) return reject(new Error("已取消"));
      const mod = target.startsWith("https:") ? https : http;
      const req = mod.get(target, (res) => {
        if (cancelled()) return reject(new Error("已取消"));
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (--redirects <= 0) return reject(new Error("重定向次数过多"));
          return attempt(new URL(res.headers.location, target).toString());
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} 下载失败: ${target}`));
        }
        const total = parseInt(res.headers["content-length"] ?? "", 10) || undefined;
        const file = fs.createWriteStream(dest);
        let bytes = 0;
        let lastBytes = 0;
        let lastTs = Date.now();
        let lastEmit = 0;
        const envWindow = parseInt(process.env.DISPATCH_DOWNLOAD_NOPROGRESS_MS ?? "", 10);
        const noProgressMs = Number.isFinite(envWindow) && envWindow >= 500 ? envWindow : 60000; // 默认 60 秒（L7/V9）
        const tickMs = Math.min(5000, Math.max(400, Math.floor(noProgressMs / 4)));
        const watchdog = setInterval(() => {
          if (Date.now() - lastTs > noProgressMs) {
            clearInterval(watchdog);
            req.destroy(new Error(`无进度超时（${Math.round(noProgressMs / 1000)} 秒没有任何下载进度），已中断（判定卡住）`));
          }
        }, tickMs);
        res.on("data", (c: Buffer) => {
          bytes += c.length;
          file.write(c);
          const now = Date.now();
          if (now - lastEmit > 500 || (total && bytes >= total)) {
            lastEmit = now;
            const speed = ((bytes - lastBytes) * 1000) / Math.max(1, now - lastTs);
            lastBytes = bytes;
            lastTs = now;
            onProgress({
              step,
              percent: total ? Math.round((bytes / total) * 100) : undefined,
              bytes,
              speedBps: speed,
            });
          }
        });
        res.on("error", (e) => {
          clearInterval(watchdog);
          file.close();
          reject(e);
        });
        res.on("end", () => {
          clearInterval(watchdog);
          file.end(() => resolve());
        });
      });
      req.on("error", (e) => reject(e));
      req.setTimeout(120000, () => req.destroy(new Error("下载超时")));
    };
    attempt(url);
  });
}

/** 解压 zip：Windows 用自带 PowerShell，Linux 用 unzip。 */
function unzip(zip: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const cmd = isWin ? "powershell.exe" : "unzip";
    const args = isWin
      ? ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${destDir}' -Force`]
      : ["-o", zip, "-d", destDir];
    execFile(cmd, args, { timeout: 600000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`解压失败: ${stderr || err.message}`));
      resolve();
    });
  });
}

/** 获取 Windows MinGit 最新版下载地址（git-for-windows 官方 release 资产）。 */
async function latestMinGitUrl(): Promise<string> {
  const meta: any = await new Promise((resolve, reject) => {
    https
      .get({ hostname: "api.github.com", path: "/repos/git-for-windows/git/releases/latest", headers: { "User-Agent": "dispatch-center" } }, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
  const asset = (meta.assets ?? []).find((a: any) => /^MinGit-.*-64-bit\.zip$/.test(a.name) && !/busybox/.test(a.name));
  if (!asset) throw new Error("未找到 MinGit 下载地址");
  return asset.browser_download_url;
}

/** 解析 `npx playwright install --dry-run chromium` 输出：给出官方下载 URL 与安装目录。 */
async function playwrightDryRun(): Promise<{ url: string; installLocation: string }[]> {
  const r = await runCmd("npx", ["playwright", "install", "--dry-run", "chromium"], 60000);
  if (r.code !== 0 && !r.out.includes("Download url")) throw new Error(`playwright --dry-run 失败: ${r.out.slice(-200)}`);
  const out = r.out;
  const items: { url: string; installLocation: string }[] = [];
  const lines = out.split(/\r?\n/);
  let lastUrl = "";
  for (const line of lines) {
    const mUrl = line.match(/Download url:\s*(\S+)/);
    const mLoc = line.match(/Install location:\s*(.+)$/);
    if (mUrl) lastUrl = mUrl[1];
    if (mLoc && lastUrl) {
      // 只装 chromium 与 chromium-headless-shell（headless 验收必需）；跳过 ffmpeg
      if (/chromium/i.test(lastUrl) || /chromium/i.test(path.basename(mLoc[1].trim()))) {
        items.push({ url: lastUrl, installLocation: mLoc[1].trim() });
      }
      lastUrl = "";
    }
  }
  if (items.length === 0) throw new Error("无法从 playwright --dry-run 解析下载地址");
  return items;
}

/**
 * 安装 Playwright Chromium（需求 11.2 固定顺序）：
 * ② 国内镜像 → ③ 官方源；每步失败记录原因再走下一步（L7）。
 * 自己下载 zip（带字节进度与 60 秒无进展中断）+ 解压 + INSTALLATION_COMPLETE 标记。
 */
async function installChromiumWithProgress(installId: string, onProgress: Progress, cancelled: () => boolean): Promise<{ ok: boolean; detail: string }> {
  const attempts: { label: string; urlOf: (official: string) => string }[] = [
    { label: "国内镜像", urlOf: (official) => official.replace(/^https?:\/\/[^/]+/, getConfig().env.mirrorDownloadHost) },
    { label: "官方源", urlOf: (official) => official },
  ];
  const reasons: string[] = [];
  const browsersRoot = path.join(toolsDir(), "playwright-browsers");
  fs.mkdirSync(browsersRoot, { recursive: true });
  let items: { url: string; installLocation: string }[];
  try {
    items = await playwrightDryRun();
  } catch (e: any) {
    // 解析失败兜底：退回 npx playwright install（官方安装器），镜像通过环境变量指定
    onProgress({ step: "使用 Playwright 官方安装器下载", log: e.message });
    const envHost = new URL(getConfig().env.mirrorDownloadHost).origin;
    const envList: Record<string, string>[] = [{ PLAYWRIGHT_DOWNLOAD_HOST: envHost }, {}];
    for (const env of envList) {
      if (cancelled()) return { ok: false, detail: "已取消" };
      const r = await runCmd("npx", ["playwright", "install", "chromium"], 1200000, {
        PLAYWRIGHT_BROWSERS_PATH: browsersRoot,
        ...env,
      });
      if (r.code === 0) return { ok: true, detail: `Chromium 已下载到 ${browsersRoot}` };
      reasons.push(`${Object.keys(env)[0] ?? "官方源"}: ${r.out.slice(-200)}`);
    }
    return { ok: false, detail: `Chromium 下载失败（${reasons.join("；")}）` };
  }

  for (const attempt of attempts) {
    if (cancelled()) return { ok: false, detail: "已取消" };
    let failed = false;
    for (const item of items) {
      const url = attempt.urlOf(item.url);
      const name = path.basename(item.installLocation);
      onProgress({ step: `${attempt.label}：下载 ${name}`, log: url });
      const zip = path.join(browsersRoot, `${name}.zip`);
      try {
        await downloadFile(
          url,
          zip,
          (p) => onProgress({ step: `${attempt.label}：${name}`, percent: p.percent, bytes: p.bytes, speedBps: p.speedBps }),
          `${attempt.label} ${name}`,
          cancelled
        );
        fs.mkdirSync(item.installLocation, { recursive: true });
        await unzip(zip, item.installLocation);
        fs.writeFileSync(path.join(item.installLocation, "INSTALLATION_COMPLETE"), new Date().toISOString(), "utf8");
        fs.rmSync(zip, { force: true });
        onProgress({ step: `${name} 完成`, percent: 100 });
      } catch (e: any) {
        failed = true;
        reasons.push(`${attempt.label} ${name}: ${e.message}`);
        logError("envcheck", `Chromium ${attempt.label} 失败: ${e.message}`);
        fs.rmSync(zip, { force: true });
        break; // 换下一个源
      }
    }
    if (!failed) {
      return { ok: true, detail: `Chromium 已安装到 ${browsersRoot}（来源：${attempt.label}）` };
    }
  }
  return { ok: false, detail: `Chromium 各下载源均失败：${reasons.join("；")}` };
}

/** npm 安装 codex（进度来自输出增长；60 秒无输出判卡，需求 11.3）。 */
function npmInstallCodexWithProgress(onProgress: Progress, cancelled: () => boolean, childRef: { child: ChildProcess | null }): Promise<{ ok: boolean; detail: string }> {
  const prefix = path.join(toolsDir(), "npm");
  fs.mkdirSync(prefix, { recursive: true });
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    let outSize = 0;
    let lastTs = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - lastTs > 60000) {
        onProgress({ step: "npm install 60 秒无输出，判定卡住", log: "中断本次尝试" });
        try {
          if (isWin && childRef.child?.pid) execFile("taskkill", ["/PID", String(childRef.child.pid), "/T", "/F"], { windowsHide: true }, () => {});
          else childRef.child?.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }, 5000);
    const finish = (r: { ok: boolean; detail: string }) => {
      clearInterval(timer);
      resolve(r);
    };
    try {
      const child = spawn(isWin ? "cmd.exe" : "npm", isWin ? ["/c", "npm", "install", "--prefix", prefix, "@openai/codex"] : ["install", "--prefix", prefix, "@openai/codex"], {
        windowsHide: true,
        env: { ...process.env },
      });
      childRef.child = child;
      child.stdout?.on("data", (c: Buffer) => {
        outSize += c.length;
        lastTs = Date.now();
        onProgress({ step: "npm 安装 @openai/codex", bytes: outSize, log: c.toString().slice(-200) });
      });
      child.stderr?.on("data", (c: Buffer) => {
        outSize += c.length;
        lastTs = Date.now();
        onProgress({ step: "npm 安装 @openai/codex", bytes: outSize, log: c.toString().slice(-200) });
      });
      child.on("close", (code) => {
        if (code === 0) finish({ ok: true, detail: `codex 已安装到 ${prefix}` });
        else finish({ ok: false, detail: `安装 codex 失败（退出码 ${code}）：npm install --prefix ${prefix} @openai/codex` });
      });
      child.on("error", (e) => finish({ ok: false, detail: `npm 无法启动: ${e.message}（请确认 npm 已安装并在 PATH 中）` }));
    } catch (e: any) {
      finish({ ok: false, detail: `安装失败: ${e.message}` });
    }
  });
}

/**
 * 启动一键修复（异步，带进度事件与取消）。
 * 每个依赖最多 3 次尝试（L7），按「系统已装 → 国内镜像 → 官方源」换源；
 * 全部失败报告原因和手动办法，不无限等待。
 */
export function startFix(tool: string): InstallHandle {
  const id = `fix-${Date.now()}-${++installSeq}`;
  let cancelled = false;
  const childRef: { child: ChildProcess | null } = { child: null };
  const emit = (p: { step: string; percent?: number; bytes?: number; speedBps?: number; log?: string }) => {
    publish({ type: "envcheck-progress", installId: id, step: p.step, percent: p.percent, bytes: p.bytes, speedBps: p.speedBps, log: p.log });
  };
  // 先注册句柄再启动安装：安装的同步前置检查（如系统浏览器检测）可能瞬间完成并触发
  // finally 清理；若后注册会把已结束的句柄重新放回表里，导致「已结束的安装」永远可取消。
  const handle: InstallHandle = {
    id,
    tool,
    promise: null as unknown as Promise<{ ok: boolean; detail: string }>,
    cancel: () => {
      cancelled = true;
      try {
        if (process.platform === "win32" && childRef.child?.pid) execFile("taskkill", ["/PID", String(childRef.child.pid), "/T", "/F"], { windowsHide: true }, () => {});
        else childRef.child?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    },
  };
  activeInstalls.set(id, handle);
  handle.promise = (async (): Promise<{ ok: boolean; detail: string }> => {
    try {
      if (tool === "codex") {
        const r = await npmInstallCodexWithProgress(emit, () => cancelled, childRef);
        if (r.ok) info("envcheck", "codex 便携安装完成");
        return r;
      }
      if (tool === "chromium") {
        // 先看系统已装 Edge/Chrome（需求 11.2 第 1 顺位）
        try {
          const pw = require("playwright");
          for (const channel of ["msedge", "chrome"]) {
            try {
              const p = pw.chromium.executablePath(channel);
              if (p && fs.existsSync(p)) {
                emit({ step: `检测到系统已装 ${channel === "msedge" ? "Edge" : "Chrome"}，无需下载`, percent: 100 });
                return { ok: true, detail: `使用系统已装浏览器（${channel}），验收将直接使用它` };
              }
            } catch {
              /* 该 channel 不存在 */
            }
          }
        } catch {
          /* playwright 未安装 */
        }
        return await installChromiumWithProgress(id, emit, () => cancelled);
      }
      if (tool === "git" && process.platform === "win32") {
        const url = await latestMinGitUrl();
        const zip = path.join(toolsDir(), "MinGit.zip");
        fs.mkdirSync(toolsDir(), { recursive: true });
        emit({ step: "下载 MinGit（git-for-windows 官方）", log: url });
        await downloadFile(url, zip, (p) => emit({ step: "MinGit 便携包", percent: p.percent, bytes: p.bytes, speedBps: p.speedBps }), "MinGit", () => cancelled);
        emit({ step: "解压 MinGit 到 tools\\MinGit" });
        await unzip(zip, path.join(toolsDir(), "MinGit"));
        fs.unlinkSync(zip);
        info("envcheck", "MinGit 便携安装完成");
        return { ok: true, detail: `Git(MinGit) 已解压到 ${path.join(toolsDir(), "MinGit")}` };
      }
      return { ok: false, detail: "该项暂不支持一键修复，请查看体检详情中的中文提示。" };
    } catch (e: any) {
      logError("envcheck", `修复失败: ${e.message}`);
      return { ok: false, detail: `修复失败: ${e.message}` };
    } finally {
      activeInstalls.delete(id);
      publish({ type: "envcheck-progress", installId: id, step: cancelled ? "已取消" : "结束", done: true, ok: !cancelled });
    }
  })();
  return handle;
}

/** 兼容旧调用（无进度版本）：内部转 startFix 并等待结果。 */
export async function fixTool(id: string): Promise<{ ok: boolean; detail: string }> {
  const h = startFix(id);
  return h.promise;
}

/** 给子进程（工人/验收）补充便携工具的 PATH。 */
export function portablePathEnv(): Record<string, string> {
  const extra: string[] = [];
  const minGit = path.join(toolsDir(), "MinGit", "cmd");
  if (fs.existsSync(minGit)) extra.push(minGit);
  const npmBin = path.join(toolsDir(), "npm", "node_modules", ".bin");
  if (fs.existsSync(npmBin)) extra.push(npmBin);
  if (extra.length === 0) return {};
  const sep = process.platform === "win32" ? ";" : ":";
  return { PATH: extra.join(sep) + sep + (process.env.PATH ?? "") };
}

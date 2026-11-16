/**
 * 环境体检 + 一键修复（需求 6.7 / A4）。
 * - 启动时自动检测：Node、Git、Python(按需)、工人 CLI、Playwright Chromium。
 * - 缺失项可一键安装：优先安装到调度中心自己的目录（便携方式），不污染系统环境。
 *   - codex CLI：npm 安装到 <程序目录>/tools/npm（包名 @openai/codex，
 *     依据：本机 codex 实际安装路径 /opt/npm/lib/node_modules/@openai/codex/bin/codex.js，
 *     以及 `npm view @openai/codex bin` 返回 { codex: 'bin/codex.js' }）。
 *   - Chromium：`npx playwright install chromium`，并设置 PLAYWRIGHT_BROWSERS_PATH
 *     指向 <程序目录>/tools/playwright-browsers（下载到调度中心自己的目录）。
 *   - Git(Windows)：下载 MinGit 便携包解压到 <程序目录>/tools/MinGit（不运行安装器）。
 *   - Python：第一期只检测并提示（按需），便携安装方式记入 README 待确认事项。
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";
import { toolsDir, appRoot } from "../util/paths";
import { info, error as logError } from "../logger";
import { getConfig } from "../config";

export interface CheckResult {
  id: string;
  name: string;
  ok: boolean;
  detail: string; // 中文提示
  version?: string;
  fixable: boolean;
  fixDescription?: string;
}

/**
 * 运行外部命令，永远 resolve、绝不 reject：任何失败（含 spawn 同步抛错）都以
 * { code: 1, out: 错误信息 } 返回，保证体检/修复不会因单项命令起不来而整体抛错。
 * Windows 上 npm/npx/codex 都是 .cmd 启动器，Node 20.12+（CVE-2024-27980 安全策略）
 * 禁止不经 shell 直接启动 .bat/.cmd，因此 win32 统一走 shell，并把含空格的参数手工加引号
 * （shell:true 时 Node 不做参数转义；与 src/worker/codex.ts 的 joinCommand 同一做法）。
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

/** Windows shell 模式下把 exe 与参数拼成一条命令行，含空格的部分加引号（同 src/worker/codex.ts joinCommand）。 */
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
  const portableBin = path.join(
    toolsDir(),
    "npm",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "codex.cmd" : "codex"
  );
  if (fs.existsSync(portableBin)) return portableBin;
  return process.platform === "win32" ? "codex.cmd" : "codex";
}

/** 逐项体检。 */
export async function runEnvCheck(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Node（运行调度中心必需，>=18）
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

  // Git（任务快照与回滚需要）
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

  // Python（按需检测，第一期只提示）
  {
    const r3 = await runCmd("python3", ["--version"]);
    const r = r3.code === 0 ? r3 : await runCmd("python", ["--version"]);
    results.push({
      id: "python",
      name: "Python（按需）",
      ok: r.code === 0,
      detail: r.code === 0 ? `${r.out} 可用` : "Python 未安装（仅当项目需要 Python 时才必须）",
      version: r.code === 0 ? r.out : undefined,
      fixable: false,
      fixDescription: "第一期暂未提供 Python 便携安装，请手动安装后重试体检。",
    });
  }

  // 工人 CLI：codex（优先用设置中心配置的路径；未配置时探测便携安装与 PATH）
  {
    const configured = getConfig().worker.executablePath.trim();
    const exe = configured || codexExecutable();
    const r = await runCmd(exe, ["--version"]);
    results.push({
      id: "codex",
      name: "工人 CLI（codex）",
      ok: r.code === 0,
      detail: r.code === 0
        ? `codex ${r.out} 可用${configured ? "（使用配置路径）" : ""}`
        : configured
          ? `配置的工人路径不可用: ${configured}（可在设置中心清空以自动探测，或一键修复）`
          : "codex CLI 未找到或不可用（工人执行需要）",
      version: r.code === 0 ? r.out : undefined,
      fixable: true,
      fixDescription: "将用 npm 把 @openai/codex 安装到调度中心目录 tools\\npm（便携，不改系统全局）。",
    });
  }

  // Playwright + Chromium（验收用）
  {
    let pwInstalled = false;
    let chromiumOk = false;
    let version = "";
    try {
      const pw = require("playwright");
      pwInstalled = true;
      version = require("playwright/package.json").version;
      const exePath = pw.chromium.executablePath();
      chromiumOk = !!exePath && fs.existsSync(exePath);
    } catch {
      pwInstalled = false;
    }
    results.push({
      id: "chromium",
      name: "验收浏览器（Playwright Chromium）",
      ok: pwInstalled && chromiumOk,
      detail: !pwInstalled
        ? "Playwright 库未安装（npm install 应已包含，若缺失请重新安装依赖）"
        : chromiumOk
          ? `Playwright ${version}，Chromium 已就绪`
          : `Playwright ${version} 已安装，但 Chromium 浏览器未下载`,
      version: version || undefined,
      fixable: pwInstalled && !chromiumOk,
      fixDescription: "将下载 Chromium 到调度中心目录 tools\\playwright-browsers（约 150MB，首次运行自动下载）。",
    });
  }

  return results;
}

function download(url: string, dest: string, redirects = 3): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error("重定向次数过多"));
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(download(res.headers.location, dest, redirects - 1));
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} 下载失败: ${url}`));
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", reject);
      })
      .on("error", reject);
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
    execFile(cmd, args, { timeout: 300000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`解压失败: ${stderr || err.message}`));
      resolve();
    });
  });
}

/** 获取 Windows MinGit 最新版下载地址（git-for-windows 官方 release 资产）。 */
async function latestMinGitUrl(): Promise<string> {
  const meta: any = await new Promise((resolve, reject) => {
    https
      .get(
        {
          hostname: "api.github.com",
          path: "/repos/git-for-windows/git/releases/latest",
          headers: { "User-Agent": "dispatch-center" },
        },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(buf));
            } catch (e) {
              reject(e);
            }
          });
        }
      )
      .on("error", reject);
  });
  const asset = (meta.assets ?? []).find(
    (a: any) => /^MinGit-.*-64-bit\.zip$/.test(a.name) && !/busybox/.test(a.name)
  );
  if (!asset) throw new Error("未找到 MinGit 下载地址");
  return asset.browser_download_url;
}

/**
 * 一键修复指定工具（便携安装到调度中心目录）。
 * 调用方负责权限策略：YOLO 直接执行；分级模式先弹决策卡片。
 */
export async function fixTool(id: string): Promise<{ ok: boolean; detail: string }> {
  try {
    if (id === "codex") {
      const prefix = path.join(toolsDir(), "npm");
      fs.mkdirSync(prefix, { recursive: true });
      const r = await runCmd("npm", ["install", "--prefix", prefix, "@openai/codex"], 600000);
      if (r.code !== 0) return { ok: false, detail: `安装 codex 失败: ${r.out ? r.out.slice(-300) : "npm 命令执行失败且无输出（请确认 npm 已安装并在 PATH 中）"}` };
      info("envcheck", "codex 便携安装完成");
      return { ok: true, detail: `codex 已安装到 ${prefix}` };
    }
    if (id === "chromium") {
      const r = await runCmd("npx", ["playwright", "install", "chromium"], 1200000, {
        PLAYWRIGHT_BROWSERS_PATH: path.join(toolsDir(), "playwright-browsers"),
      });
      if (r.code !== 0) return { ok: false, detail: `Chromium 下载失败: ${r.out ? r.out.slice(-300) : "npx 命令执行失败且无输出（请确认 npx 已安装并在 PATH 中）"}` };
      info("envcheck", "Chromium 便携下载完成");
      return { ok: true, detail: "Chromium 已下载到调度中心 tools 目录" };
    }
    if (id === "git" && process.platform === "win32") {
      const url = await latestMinGitUrl();
      const zip = path.join(toolsDir(), "MinGit.zip");
      fs.mkdirSync(toolsDir(), { recursive: true });
      await download(url, zip);
      const dest = path.join(toolsDir(), "MinGit");
      await unzip(zip, dest);
      fs.unlinkSync(zip);
      info("envcheck", "MinGit 便携安装完成");
      return { ok: true, detail: `Git(MinGit) 已解压到 ${dest}` };
    }
    return { ok: false, detail: "该项暂不支持一键修复，请查看体检详情中的中文提示。" };
  } catch (e: any) {
    logError("envcheck", `修复失败: ${e.message}`);
    return { ok: false, detail: `修复失败: ${e.message}` };
  }
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

export { appRoot };

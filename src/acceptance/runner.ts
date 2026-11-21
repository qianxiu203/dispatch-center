/**
 * 验收运行器 v2（需求 5.4/8.1/8.5）：
 * - 报告 schema（5.4）：results（每条标准一项）/ problems（只放项目缺陷）/
 *   harnessErrors（调度侧缺陷）。规则：每个 passed=false 的结果必须归入 problems 或
 *   harnessErrors 之一，归不进去就是内部错误 → 任务暂停并记录日志（8.1 第 4 条分流）。
 * - 标准校验（5.3 第三处）：执行验收前再校验一次，防旧数据；缺字段 → harnessError
 *   （调度侧缺陷），绝不把「标准缺参数」当项目缺陷派工人（一期 #15 的教训）。
 * - Playwright 抓取（8.5）：控制台 error/warning、页面异常、失败的网络请求（4xx/5xx）、
 *   截图；页面加载后等网络空闲再多等 2 秒；整体超时 30 秒。
 * - 验收需要服务运行时：按项目配置的启动命令启动，端口探测判断就绪（启动超时 30 秒），
 *   结束后停止整个进程树；服务起不来算项目缺陷（problems），附启动日志。
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { execFile, spawn, ChildProcess } from "node:child_process";
import { Criterion, Task } from "../tasks/store";
import { safeJoin, dataDir } from "../util/paths";
import { getConfig } from "../config";
import { info, warn } from "../logger";
import { validateCriterion } from "../brain/criteria";

export interface CriterionResult {
  criterionId: string;
  passed: boolean;
  detail: string;
  evidence?: string; // 截图或日志文件名（需求 5.4）
}

/** 项目缺陷（只放项目自身的问题，L1 修复循环的唯一输入）。 */
export interface ProjectProblem {
  criterionId: string;
  summary: string;
  expected: string;
  actual: string;
  evidence?: string;
}

/** 调度侧缺陷（需求 5.4：验收标准有问题、环境缺失、配置错误 —— 调度中心自己的问题）。 */
export interface HarnessError {
  criterionId: string;
  code: string;
  detail: string;
}

export interface AcceptanceReport {
  allPassed: boolean;
  results: CriterionResult[];
  problems: ProjectProblem[];
  harnessErrors: HarnessError[];
  /** 内部错误：失败结果既不在 problems 也不在 harnessErrors（8.1 第 4 条 → 任务暂停）。 */
  internalError?: string;
}

/** 报告一致性检查（5.4 规则）：每个失败结果必须能归入 problems 或 harnessErrors。 */
export function classifyReport(report: AcceptanceReport): AcceptanceReport {
  const covered = new Set<string>([...report.problems.map((p) => p.criterionId), ...report.harnessErrors.map((h) => h.criterionId)]);
  for (const r of report.results) {
    if (!r.passed && !covered.has(r.criterionId)) {
      report.internalError = `标准 ${r.criterionId} 失败但既无 problems 也无 harnessErrors：${r.detail}`;
      break;
    }
  }
  return report;
}

/** 证据文件目录：data/screenshots（/api/screenshot 可展示；导出诊断包时一并脱敏检查）。 */
function evidenceDir(): string {
  return path.join(dataDir(), "screenshots");
}

function saveEvidence(name: string, content: string | Buffer): string {
  fs.mkdirSync(evidenceDir(), { recursive: true });
  fs.writeFileSync(path.join(evidenceDir(), name), content);
  return name;
}

interface CapturedIssue {
  kind: "console" | "pageerror" | "requestfailed" | "badstatus" | "browser_navigation";
  level?: string;
  text: string;
  location?: string;
  url?: string;
  statusCode?: number;
}

/** 动态加载 playwright；未安装时给出中文安装指引而不是崩溃。 */
async function loadPlaywright(): Promise<any> {
  try {
    return await import("playwright");
  } catch {
    throw new Error("Playwright 未安装。请在设置中心的环境体检里一键安装（会安装到调度中心自己的目录）。");
  }
}

async function takeScreenshot(page: any, name: string): Promise<string> {
  const file = `${name}-${Date.now()}.png`;
  fs.mkdirSync(evidenceDir(), { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir(), file), fullPage: true });
  return file;
}

/** 打开一个页面并采集报错；整体超时 30 秒（需求 8.5）。 */
export async function openAndCapture(
  url: string,
  opts: { stayMs?: number; screenshotName?: string; overallTimeoutMs?: number } = {}
): Promise<{ issues: CapturedIssue[]; screenshot?: string; loaded: boolean; finalUrl?: string }> {
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({ headless: true });
  const overallMs = opts.overallTimeoutMs ?? 30000;
  const deadline = Date.now() + overallMs;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const issues: CapturedIssue[] = [];

    page.on("console", (msg: any) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        issues.push({ kind: "console", level: msg.type(), text: `${msg.type()}: ${msg.text()}`, location: msg.location()?.url });
      }
    });
    page.on("pageerror", (err: Error) => {
      issues.push({ kind: "pageerror", text: `未捕获页面异常: ${err.message}`, location: err.stack });
    });
    page.on("requestfailed", (req: any) => {
      issues.push({ kind: "requestfailed", text: `请求失败: ${req.method()} ${req.url()} — ${req.failure()?.errorText}`, url: req.url() });
    });
    page.on("response", (res: any) => {
      if (res.status() >= 400) {
        issues.push({ kind: "badstatus", text: `HTTP ${res.status()} ${res.request().method()} ${res.url()}`, url: res.url(), statusCode: res.status() });
      }
    });

    let loaded = false;
    let finalUrl: string | undefined;
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(5000, Math.min(20000, deadline - Date.now())) });
      loaded = !!(resp && resp.ok());
      finalUrl = page.url();
    } catch (e: any) {
      issues.push({ kind: "browser_navigation", text: `页面无法打开: ${e.message}`, url });
    }
    // 等网络空闲 + 额外 2 秒（需求 8.5），整体不超过 30 秒预算
    try {
      await page.waitForLoadState("networkidle", { timeout: Math.max(1000, Math.min(8000, deadline - Date.now())) });
      await page.waitForTimeout(Math.min(2000, Math.max(0, deadline - Date.now())));
    } catch {
      /* 页面持续有请求时超时忽略 */
    }

    const shot = opts.screenshotName ? await takeScreenshot(page, opts.screenshotName) : undefined;
    return { issues, screenshot: shot, loaded, finalUrl };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** 端口探测（需求 8.5：启动服务后用端口探测判断就绪，超时 30 秒）。 */
export function probePort(port: number, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = net.connect({ port, host: "127.0.0.1", timeout: 1500 });
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tryOnce, 500);
      });
      sock.once("timeout", () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tryOnce, 500);
      });
    };
    tryOnce();
  });
}

export interface DevServerHandle {
  started: boolean;
  port?: number;
  log: string;
  stop: () => void;
}

/** 按项目配置的启动命令启动开发服务（需求 8.5）；端口探测判断就绪，30 秒超时。 */
export async function startProjectServer(projectDir: string, startCommand: string, port: number): Promise<DevServerHandle> {
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/sh";
  const shellArg = isWin ? "/c" : "-c";
  let log = "";
  let child: ChildProcess | null = null;
  const stop = () => {
    if (!child || child.pid === undefined) return;
    try {
      if (isWin) {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      } else {
        try {
          process.kill(-child.pid, "SIGTERM"); // 进程组（detached 启动）
        } catch {
          child.kill("SIGTERM");
        }
        const pid = child.pid;
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* 已退出 */
          }
        }, 2000);
      }
    } catch {
      /* ignore */
    }
    child = null;
  };
  const started = await new Promise<boolean>((resolve) => {
    try {
      child = spawn(shell, [shellArg, startCommand], { cwd: projectDir, windowsHide: true, detached: !isWin, env: { ...process.env } });
      child.stdout?.on("data", (c: Buffer) => (log += c.toString()));
      child.stderr?.on("data", (c: Buffer) => (log += c.toString()));
      child.on("error", (e) => {
        log += `\n启动失败: ${e.message}`;
        resolve(false);
      });
    } catch (e: any) {
      log += `\n启动失败: ${e.message}`;
      resolve(false);
      return;
    }
    probePort(port, 30000).then((ok) => {
      if (!ok) log += `\n启动超时（30 秒内端口 ${port} 未就绪）`;
      resolve(ok);
    });
  });
  return { started, port, log: log.slice(-8000), stop };
}

/** 解析 criterion.url 里的本机端口；不是本机 http URL 返回 null。 */
function portFromUrl(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!["127.0.0.1", "localhost"].includes(u.hostname)) return null;
    const port = parseInt(u.port, 10);
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

/** 执行单条验收标准；本函数只处理「校验通过」的标准（缺字段已在 runAcceptance 归为 harnessError）。 */
async function runCriterion(c: Criterion, projectDir: string, taskId: string): Promise<CriterionResult> {
  switch (c.kind) {
    case "web_url":
    case "web_console_clean": {
      const cfg = getConfig();
      const url = (c.url && c.url.trim()) || `http://127.0.0.1:${cfg.port}/preview/`;
      const cap = await openAndCapture(url, { screenshotName: `task-${taskId}-${c.id}` });
      const serious = cap.issues.filter((i) => i.kind !== "console");
      const consoleErrors = cap.issues.filter((i) => i.kind === "console" && i.level === "error");
      let passed = cap.loaded && serious.length === 0;
      let detail = cap.loaded ? `页面已打开: ${cap.finalUrl ?? url}` : "页面未能打开";
      if (c.kind === "web_console_clean") {
        passed = passed && consoleErrors.length === 0;
        detail += consoleErrors.length ? `；发现 ${consoleErrors.length} 条控制台 error` : "；控制台无 error";
        // warning 采集展示，但不作为失败判据（沿用一期约定）
      }
      return { criterionId: c.id, passed, detail, evidence: cap.screenshot };
    }
    case "file_exists": {
      const abs = safeJoin(projectDir, String(c.path));
      const passed = fs.existsSync(abs);
      return {
        criterionId: c.id,
        passed,
        detail: passed ? `文件存在: ${c.path}` : `文件不存在: ${c.path}`,
      };
    }
    case "command_exit_0": {
      const res = await runInProject(projectDir, String(c.command));
      const passed = res.exitCode === 0;
      let evidence: string | undefined;
      if (!passed && res.output.trim()) {
        evidence = saveEvidence(`cmd-${c.id}-${Date.now()}.log`, res.output.slice(-20000));
      }
      return {
        criterionId: c.id,
        passed,
        detail: passed ? `命令通过: ${c.command}` : `命令失败(退出码 ${res.exitCode}): ${c.command}\n${res.output.slice(-500)}`,
        evidence,
      };
    }
    default:
      return { criterionId: c.id, passed: false, detail: `未知的验收类型: ${(c as any).kind}` };
  }
}

/** 在项目目录执行命令；不依赖 bash（需求 4.4）：Windows 用 cmd，Linux 用 /bin/sh。 */
export function runInProject(
  projectDir: string,
  command: string,
  timeoutSeconds?: number,
  extraEnv?: Record<string, string>
): Promise<{ exitCode: number; output: string }> {
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const shellArg = process.platform === "win32" ? "/c" : "-c";
  const timeout = (timeoutSeconds ?? getConfig().acceptance.commandTimeoutSeconds ?? 120) * 1000;
  return new Promise((resolve) => {
    execFile(
      shell,
      [shellArg, command],
      { cwd: projectDir, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...extraEnv } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
        resolve({ exitCode: code, output: `${stdout}${stderr ? "\n" + stderr : ""}` });
      }
    );
  });
}

/** 每个失败结果对应的期望描述（problems 字段，需求 5.4）。 */
function expectedOf(c: Criterion): string {
  switch (c.kind) {
    case "web_console_clean": return "页面打开且控制台无 error";
    case "web_url": return `页面 ${c.url || "(内置预览)"} 可以打开`;
    case "file_exists": return `存在文件 ${c.path}`;
    case "command_exit_0": return `命令 ${c.command} 退出码为 0`;
  }
}

/**
 * 运行整份验收（需求 8.1）：
 * 1. 先校验每条标准（5.3 第三处）→ 不合格进 harnessErrors（绝不当项目缺陷）。
 * 2. 需要本机服务的标准 → 按项目启动命令拉起服务（端口探测，30 秒）。
 * 3. 逐条执行 → 组装报告 → classifyReport 保证每个失败可归类，否则 internalError。
 */
export async function runAcceptance(projectDir: string, task: Task, projectStartCommand?: string): Promise<AcceptanceReport> {
  const results: CriterionResult[] = [];
  const problems: ProjectProblem[] = [];
  const harnessErrors: HarnessError[] = [];

  // ── 前置校验：缺字段一律 harnessError（V1：绝不派工人，让大脑重新生成 ≤1 次） ──
  const valid: Criterion[] = [];
  for (const c of task.criteria) {
    const errs = validateCriterion(c);
    if (errs.length > 0) {
      harnessErrors.push({ criterionId: c.id, code: "CRITERION_INVALID", detail: errs.join("；") });
      results.push({ criterionId: c.id, passed: false, detail: `验收标准本身有问题（调度侧缺陷）：${errs.join("；")}` });
    } else {
      valid.push(c);
    }
  }

  // ── 需要本机服务的标准：先按项目启动命令拉起服务 ──
  const webCriteria = valid.filter((c) => c.kind === "web_url" || c.kind === "web_console_clean");
  const customPort = webCriteria.map((c) => portFromUrl(c.url ?? "")).find((p) => p !== null) ?? null;
  const serverFailed = new Set<string>();
  let devServer: DevServerHandle | null = null;
  if (customPort !== null) {
    if (projectStartCommand && projectStartCommand.trim()) {
      devServer = await startProjectServer(projectDir, projectStartCommand, customPort);
      if (!devServer.started) {
        const logFile = devServer.log ? saveEvidence(`devserver-${task.id}-${Date.now()}.log`, devServer.log) : undefined;
        for (const c of webCriteria.filter((x) => portFromUrl(x.url ?? "") === customPort)) {
          serverFailed.add(c.id);
          problems.push({
            criterionId: c.id,
            summary: `项目服务未能启动（命令：${projectStartCommand}）`,
            expected: `端口 ${customPort} 在 30 秒内可连接`,
            actual: "启动失败或超时",
            evidence: logFile,
          });
          results.push({ criterionId: c.id, passed: false, detail: `项目服务未能启动，无法验收（附启动日志）` });
        }
      }
    } else {
      // 给了服务地址却没配启动命令 → 调度侧缺陷（配置问题，不派工人）
      for (const c of webCriteria.filter((x) => portFromUrl(x.url ?? "") === customPort)) {
        harnessErrors.push({ criterionId: c.id, code: "START_COMMAND_MISSING", detail: "验收标准使用了本机服务地址，但项目未配置启动命令（可在项目设置里填写）" });
        results.push({ criterionId: c.id, passed: false, detail: "缺少项目启动命令配置（调度侧缺陷）" });
      }
    }
  }

  // ── 逐条执行（校验失败或服务启动失败的标准不再执行） ──
  for (const c of valid) {
    if (harnessErrors.some((h) => h.criterionId === c.id)) continue;
    if (serverFailed.has(c.id)) continue;
    try {
      results.push(await runCriterion(c, projectDir, task.id));
    } catch (e: any) {
      // 验收器自身故障 → harnessError（调度侧缺陷），不是项目问题
      harnessErrors.push({ criterionId: c.id, code: "VERIFIER_ERROR", detail: `验收执行失败: ${e.message}` });
      results.push({ criterionId: c.id, passed: false, detail: `验收执行失败: ${e.message}` });
    }
  }
  if (devServer) devServer.stop();

  // ── 组装 problems（只放项目缺陷；expected/actual/evidence，需求 5.4） ──
  for (const r of results) {
    if (r.passed) continue;
    const c = task.criteria.find((x) => x.id === r.criterionId)!;
    if (harnessErrors.some((h) => h.criterionId === r.criterionId)) continue;
    problems.push({
      criterionId: r.criterionId,
      summary: `${c.text}：${r.detail.split("\n")[0]}`,
      expected: expectedOf(c),
      actual: r.detail,
      evidence: r.evidence,
    });
  }

  const allPassed = results.length > 0 && results.every((r) => r.passed);
  const report = classifyReport({ allPassed, results, problems, harnessErrors });
  info("acceptance", `验收完成: ${task.id} allPassed=${allPassed} problems=${problems.length} harness=${harnessErrors.length}`, task.id);
  if (report.internalError) warn("acceptance", `验收报告内部错误: ${report.internalError}`, task.id);
  return report;
}

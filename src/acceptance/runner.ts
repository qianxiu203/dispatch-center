/**
 * 验收运行器（需求 6.5）：
 * - 用 Playwright 驱动 Chromium 打开项目页面、操作界面、截图。
 * - 必须捕获：控制台 error / warning、未捕获页面异常、失败的网络请求(4xx/5xx)。
 * - 非网页项目：用命令退出码与输出作为验收依据。
 * - Playwright 以动态 import 引入：未安装时服务仍能启动，环境体检提供一键安装。
 * - Chromium 首次运行自动下载（envcheck 用 PLAYWRIGHT_BROWSERS_PATH 指向调度中心 tools 目录，便携不污染系统）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { Criterion, Task, TaskStore } from "../tasks/store";
import { safeJoin, dataDir } from "../util/paths";
import { getConfig } from "../config";
import { info } from "../logger";

export interface StructuredProblem {
  source: "browser_console" | "browser_page" | "browser_network" | "browser_navigation" | "command" | "file";
  pageUrl?: string;
  message: string;
  stack?: string;
  requestUrl?: string;
  statusCode?: number;
  screenshot?: string; // 文件名（data/screenshots 下）
}

export interface CriterionResult {
  criterionId: string;
  passed: boolean;
  detail: string;
  screenshot?: string;
  problems: StructuredProblem[];
}

export interface AcceptanceReport {
  allPassed: boolean;
  results: CriterionResult[];
  problems: StructuredProblem[];
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
  const dir = path.join(dataDir(), "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  const file = `${name}-${Date.now()}.png`;
  await page.screenshot({ path: path.join(dir, file), fullPage: true });
  return file;
}

/** 打开一个页面并采集报错（控制台/页面异常/失败请求），返回采集结果与截图。 */
export async function openAndCapture(
  url: string,
  opts: { stayMs?: number; screenshotName?: string } = {}
): Promise<{ issues: CapturedIssue[]; screenshot?: string; loaded: boolean; finalUrl?: string }> {
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const issues: CapturedIssue[] = [];

    page.on("console", (msg: any) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        issues.push({
          kind: "console",
          level: msg.type(),
          text: `${msg.type()}: ${msg.text()}`,
          location: msg.location()?.url,
        });
      }
    });
    page.on("pageerror", (err: Error) => {
      issues.push({ kind: "pageerror", text: `未捕获页面异常: ${err.message}`, location: err.stack });
    });
    page.on("requestfailed", (req: any) => {
      issues.push({
        kind: "requestfailed",
        text: `请求失败: ${req.method()} ${req.url()} — ${req.failure()?.errorText}`,
        url: req.url(),
      });
    });
    page.on("response", (res: any) => {
      if (res.status() >= 400) {
        issues.push({
          kind: "badstatus",
          text: `HTTP ${res.status()} ${res.request().method()} ${res.url()}`,
          url: res.url(),
          statusCode: res.status(),
        });
      }
    });

    let loaded = false;
    let finalUrl: string | undefined;
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      loaded = !!(resp && resp.ok());
      finalUrl = page.url();
    } catch (e: any) {
      issues.push({ kind: "browser_navigation", text: `页面无法打开: ${e.message}`, url });
    }
    // 等待网络空闲 + 额外停留，尽量抓齐延迟报错
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch {
      /* 页面持续有请求时超时忽略 */
    }
    await page.waitForTimeout(opts.stayMs ?? 1500);

    const shot = opts.screenshotName ? await takeScreenshot(page, opts.screenshotName) : undefined;
    return { issues, screenshot: shot, loaded, finalUrl };
  } finally {
    await browser.close();
  }
}

/** 运行单条验收标准。 */
async function runCriterion(c: Criterion, projectDir: string, taskId: string): Promise<CriterionResult> {
  const problems: StructuredProblem[] = [];
  switch (c.kind) {
    case "web_url":
    case "web_console_clean": {
      // url 缺省时使用调度中心内置的项目静态预览（静态网页项目无需自启服务）
      const cfg = getConfig();
      const url = c.url || `http://127.0.0.1:${cfg.port}/preview/`;
      const cap = await openAndCapture(url, { screenshotName: `task-${taskId}-${c.id}` });
      for (const i of cap.issues) {
        problems.push({
          source:
            i.kind === "console"
              ? "browser_console"
              : i.kind === "pageerror"
                ? "browser_page"
                : i.kind === "requestfailed" || i.kind === "badstatus"
                  ? "browser_network"
                  : "browser_navigation",
          pageUrl: i.url ?? cap.finalUrl ?? url,
          message: i.text,
          stack: i.location,
          requestUrl: i.url,
          statusCode: i.statusCode,
          screenshot: cap.screenshot,
        });
      }
      const consoleErrors = cap.issues.filter((i) => i.kind === "console" && i.level === "error");
      const serious = cap.issues.filter(
        (i) => i.kind === "pageerror" || i.kind === "requestfailed" || i.kind === "badstatus" || i.kind === "browser_navigation"
      );
      let passed = cap.loaded && serious.length === 0;
      let detail = cap.loaded ? `页面已打开: ${cap.finalUrl ?? url}` : "页面未能打开";
      if (c.kind === "web_console_clean") {
        passed = passed && consoleErrors.length === 0;
        detail += consoleErrors.length ? `；发现 ${consoleErrors.length} 条控制台 error` : "；控制台无 error";
        // warning 会被采集进 problems 展示，但不作为失败判据
      }
      return { criterionId: c.id, passed, detail, screenshot: cap.screenshot, problems };
    }
    case "file_exists": {
      if (!c.path) return { criterionId: c.id, passed: false, detail: "验收标准缺少 path 参数", problems };
      const abs = safeJoin(projectDir, c.path);
      const passed = fs.existsSync(abs);
      return {
        criterionId: c.id,
        passed,
        detail: passed ? `文件存在: ${c.path}` : `文件不存在: ${c.path}`,
        problems: passed ? [] : [{ source: "file", message: `缺少文件: ${c.path}` }],
      };
    }
    case "command_exit_0": {
      if (!c.command) return { criterionId: c.id, passed: false, detail: "验收标准缺少 command 参数", problems };
      const res = await runInProject(projectDir, c.command);
      const passed = res.exitCode === 0;
      if (!passed) {
        problems.push({
          source: "command",
          message: `命令退出码 ${res.exitCode}: ${c.command}`,
          stack: res.output.slice(-2000),
        });
      }
      return {
        criterionId: c.id,
        passed,
        detail: passed ? `命令通过: ${c.command}` : `命令失败(退出码 ${res.exitCode}): ${c.command}\n${res.output.slice(-500)}`,
        problems,
      };
    }
    default:
      return { criterionId: c.id, passed: false, detail: `未知的验收类型: ${(c as any).kind}`, problems };
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

/** 运行整份验收：把结果写入任务并返回结构化报告。 */
export async function runAcceptance(
  projectDir: string,
  store: TaskStore,
  task: Task
): Promise<AcceptanceReport> {
  const results: CriterionResult[] = [];
  for (const c of task.criteria) {
    try {
      results.push(await runCriterion(c, projectDir, task.id));
    } catch (e: any) {
      results.push({
        criterionId: c.id,
        passed: false,
        detail: `验收执行失败: ${e.message}`,
        problems: [{ source: "command", message: `验收执行失败(${c.kind}): ${e.message}` }],
      });
    }
  }
  const problems = results.flatMap((r) => r.problems);
  const allPassed = results.every((r) => r.passed);
  for (const r of results) {
    store.setCriteria(task, r.criterionId, {
      status: r.passed ? "passed" : "failed",
      detail: r.detail,
      screenshot: r.screenshot,
    });
  }
  info("acceptance", `验收完成: ${task.id} allPassed=${allPassed} problems=${problems.length}`);
  return { allPassed, results, problems };
}

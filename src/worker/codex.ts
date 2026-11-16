/**
 * codex 适配器（非交互模式驱动，绝不模拟键盘 —— 需求 6.3）。
 *
 * ── 命令依据（2026-11-16 在本机执行 `codex exec --help` 核对，codex-cli 0.167.2 与便携安装的 0.169.0 两个版本）──
 * - `codex exec [OPTIONS] [PROMPT]`：官方说明 "Run Codex non-interactively"。
 * - 提示词可经 stdin 传入：帮助原文 "If not provided as an argument (or if `-` is used),
 *   instructions are read from stdin." —— 我们始终走 stdin，避免 Windows 命令行引号/换行转义问题。
 * - `-C, --cd <DIR>`：指定工人工作根目录（即项目目录，保证产物落在项目内，需求 4.3）。
 * - `--json`：帮助原文 "Print events to stdout as JSONL"，用于流式读取进度事件。
 * - `--skip-git-repo-check`：帮助原文 "Allow running Codex outside a Git repository"。
 * - `-o, --output-last-message <FILE>`：把最后一条 agent 消息写入文件，供我们读取结论。
 * - 沙箱/审批（按模式选择，需求 6.4）：
 *     YOLO    → `--dangerously-bypass-approvals-and-sandbox`
 *               帮助原文 "Skip all confirmation prompts and execute commands without sandboxing."，
 *               即免确认/绕过审批模式；配合本服务自己的硬拦截规则（policy 模块）作安全网。
 *     分级询问 → `-s workspace-write`（帮助列出的 possible values:
 *               read-only | workspace-write | danger-full-access），不绕过审批。
 * - `-m, --model <MODEL>`、`-c, --config <key=value>`：模型与配置覆盖。
 * - 续聊：`codex exec resume [SESSION_ID] [PROMPT]`（同样支持 stdin 传提示词）。
 *
 * ⚠ 重要教训：codex 0.167.2 / 0.169.0 的 exec 都没有 --full-auto 参数（--help 全量参数列表中不存在），
 *   上一版凭记忆使用导致工人调用必失败。本文件所有参数均以上述 --help 实测输出为准。
 *
 * ── JSONL 事件结构依据（2026-11-16 本机实跑 `codex exec --json` 捕获的真实输出）──
 *   {"type":"thread.started","thread_id":"01a1e311-..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"..."}}
 *   {"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"..."}}
 *   {"type":"item.started","item":{"id":"item_3","type":"command_execution","command":"...","aggregated_output":"","exit_code":null,"status":"in_progress"}}
 *   {"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"...","aggregated_output":"hello\n","exit_code":0,"status":"completed"}}
 *   {"type":"turn.completed","usage":{...}}
 *   失败时：{"type":"error","message":"..."}、{"type":"turn.failed","error":{"message":"..."}}
 */
import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkerAdapter, WorkerEvent, WorkerRunOptions, WorkerRunResult } from "./types";
import { getConfig } from "../config";
import { classifyCommand } from "../policy/permissions";
import { info, warn } from "../logger";
import { toolsDir } from "../util/paths";

interface PumpHooks {
  onThreadId: (id: string) => void;
  onBlock: (cmd: string, ruleId: string, ruleLabel: string) => void;
  onAsk: (cmd: string) => void;
  setLastMessage: (t: string) => void;
  onTurnFailed: (m: string) => void;
}

export class CodexAdapter implements WorkerAdapter {
  readonly kind = "codex";

  run(opts: WorkerRunOptions): { stop: () => void; result: Promise<WorkerRunResult> } {
    const { exe, args, lastMsgFile } = this.buildCommand(opts);
    const child = this.spawn(opts, exe, args);
    const result = this.pump(child, opts, lastMsgFile);
    return {
      stop: () => {
        if (!child.killed) {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2000);
        }
      },
      result,
    };
  }

  /**
   * 计算可执行文件与启动参数。
   * Windows 上 npm 安装的工人是 .cmd 启动器（需求 4.2），必须用 shell 方式启动，
   * Node 直接 spawn .cmd 会因 EINVAL 安全策略失败。
   */
  private resolveExecutable(): string {
    const cfg = getConfig().worker;
    if (cfg.executablePath) return cfg.executablePath;
    // 优先用调度中心便携安装的 codex（需求 6.7 便携安装）
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

  /** 拼接 exec/resume 的完整参数与最后消息文件路径。 */
  private buildCommand(opts: WorkerRunOptions, resumeThreadId?: string): { exe: string; args: string[]; lastMsgFile: string } {
    const cfg = getConfig().worker;
    const args: string[] = ["exec"];
    if (resumeThreadId) {
      // 依据：codex exec resume --help（0.167.2）："Resume a previous session by id ..."
      args.push("resume", resumeThreadId);
    }
    args.push("--json");
    args.push("--skip-git-repo-check");
    args.push("-C", opts.projectDir);
    if (opts.mode === "yolo") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push("-s", "workspace-write");
    }
    // 工人走中转/自定义 provider 时通过 -c 覆盖（依据：-c, --config <key=value> 帮助项；
    // 值不写 TOML 引号，依赖其 "解析失败则按原始字符串" 的回退行为，规避 Windows 引号转义问题）
    if (cfg.baseUrl) {
      args.push("-c", 'model_providers.dispatch.name=dispatch');
      args.push("-c", `model_providers.dispatch.base_url=${cfg.baseUrl}`);
      args.push("-c", 'model_providers.dispatch.env_key=DISPATCH_WORKER_API_KEY');
      args.push("-c", 'model_provider=dispatch');
    }
    if (cfg.model) {
      args.push("-m", cfg.model);
    }
    // 最后一条消息写入临时文件，供结果读取（依据：-o, --output-last-message <FILE>）
    const lastMsgFile = path.join(os.tmpdir(), `dispatch-codex-last-${Date.now()}-${process.pid}.txt`);
    args.push("-o", lastMsgFile);
    return { exe: this.resolveExecutable(), args, lastMsgFile };
  }

  private spawn(opts: WorkerRunOptions, exe: string, args: string[]): ChildProcess {
    const env = { ...process.env };
    const cfg = getConfig().worker;
    if (cfg.apiKey) env["DISPATCH_WORKER_API_KEY"] = cfg.apiKey;

    info("codex", `启动工人: ${exe} (模式=${opts.mode})`);
    // Windows 下 .cmd 启动器必须经 shell 启动（需求 4.2）；整条命令行手工加引号
    const useShell = process.platform === "win32";
    const child = useShell
      ? spawn(joinCommand(exe, args), { shell: true, cwd: opts.projectDir, env })
      : spawn(exe, args, { cwd: opts.projectDir, env });
    // 提示词走 stdin（依据 --help：未给 PROMPT 参数时从 stdin 读取）
    child.stdin!.write(opts.prompt);
    child.stdin!.end();
    return child;
  }

  private async pump(child: ChildProcess, opts: WorkerRunOptions, lastMsgFile: string): Promise<WorkerRunResult> {
    let threadId: string | undefined;
    let lastMessage = "";
    let errMsg: string | undefined;
    let killedForBlock = false;
    let turnFailed = false;

    await new Promise<void>((resolve) => {
      let stdoutBuf = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        let idx: number;
        while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (!line) continue;
          this.handleEventLine(line, opts, {
            onThreadId: (id) => (threadId = id),
            onBlock: (cmd) => {
              killedForBlock = true;
              // 硬拦截：立即终止工人（需求 6.4，固定规则判断）
              warn("codex", `硬拦截并终止工人: ${cmd}`);
              if (!child.killed) child.kill("SIGKILL");
            },
            onAsk: () => {
              // 分级模式：需要询问的命令出现 → 终止本轮，等用户决策卡片
              if (!child.killed) child.kill("SIGTERM");
            },
            setLastMessage: (t) => (lastMessage = t),
            onTurnFailed: (m) => {
              turnFailed = true;
              errMsg = m;
            },
          });
        }
      });
      child.stderr!.on("data", (c: Buffer) => {
        const t = c.toString("utf8").trim();
        if (t) opts.onEvent({ kind: "error", text: t });
      });
      child.on("close", () => resolve());
      child.on("error", (e) => {
        errMsg = String(e.message);
        resolve();
      });
    });

    if (!killedForBlock && fs.existsSync(lastMsgFile)) {
      try {
        lastMessage = fs.readFileSync(lastMsgFile, "utf8").trim();
        fs.unlinkSync(lastMsgFile);
      } catch {
        /* 读取失败不影响结果判定 */
      }
    }

    const ok = !turnFailed && !errMsg && !killedForBlock && child.exitCode === 0;
    return { ok, lastMessage, threadId, error: errMsg };
  }

  /** 解析一行 JSONL 事件并转发为 WorkerEvent。事件类型以实测输出为准（见文件头注释）。 */
  private handleEventLine(line: string, opts: WorkerRunOptions, hooks: PumpHooks): void {
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      return; // 非 JSONL 行忽略
    }
    switch (evt.type) {
      case "thread.started":
        if (evt.thread_id) {
          hooks.onThreadId(evt.thread_id);
          opts.onEvent({ kind: "thread", threadId: evt.thread_id });
        }
        break;
      case "turn.started":
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = evt.item ?? {};
        switch (item.type) {
          case "agent_message":
            if (item.text) {
              hooks.setLastMessage(item.text);
              if (evt.type === "item.completed") opts.onEvent({ kind: "message", text: item.text });
            }
            break;
          case "reasoning":
            if (item.text && evt.type === "item.completed") {
              opts.onEvent({ kind: "reasoning", text: item.text });
            }
            break;
          case "command_execution": {
            const cmd: string = item.command ?? "";
            const exitCode: number | null = item.exit_code ?? null;
            const running = item.status === "in_progress";
            // 权限裁决：固定规则，不依赖大模型（需求 6.4）
            const { verdict, rule } = classifyCommand(cmd, opts.mode);
            if (verdict === "block") {
              opts.onEvent({
                kind: "permission",
                verdict: "block",
                command: cmd,
                ruleId: rule?.id,
                ruleLabel: rule?.label,
              });
              hooks.onBlock(cmd, rule?.id ?? "", rule?.label ?? "");
              return;
            }
            if (verdict === "ask" && !running) {
              // 分级模式：出现需询问的命令 → 终止本轮等待用户决策
              opts.onEvent({
                kind: "permission",
                verdict: "ask",
                command: cmd,
                ruleId: rule?.id,
                ruleLabel: rule?.label,
              });
              hooks.onAsk(cmd);
              return;
            }
            opts.onEvent({
              kind: "command",
              command: cmd,
              output: running ? undefined : item.aggregated_output,
              exitCode: running ? undefined : exitCode,
            });
            break;
          }
          case "file_change":
            opts.onEvent({ kind: "file", text: JSON.stringify(item.changes ?? item) });
            break;
          case "error":
            opts.onEvent({ kind: "error", text: item.message ?? "" });
            break;
          default:
            // 未知 item 类型：容错忽略，不崩
            break;
        }
        break;
      }
      case "error":
        opts.onEvent({ kind: "error", text: evt.message ?? "" });
        break;
      case "turn.failed":
        hooks.onTurnFailed(evt.error?.message ?? "turn.failed");
        opts.onEvent({ kind: "fatal", text: evt.error?.message ?? "turn.failed" });
        break;
      case "turn.completed":
        break;
      default:
        break;
    }
  }
}

/** Windows shell:true 模式下把 exe 与参数拼成一条命令行，含空格的部分加引号。 */
function joinCommand(exe: string, args: string[]): string {
  const q = (a: string) => (/\s/.test(a) && !/^".*"$/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return [exe, ...args].map(q).join(" ");
}

/** 适配器注册表：新增工人只需新增一个适配器文件并在此注册（需求 6.3）。 */
const registry = new Map<string, WorkerAdapter>();
registry.set("codex", new CodexAdapter());

export function getAdapter(kind: string): WorkerAdapter {
  const a = registry.get(kind);
  if (!a) throw new Error(`未注册的工人类型: ${kind}`);
  return a;
}

export function registerAdapter(adapter: WorkerAdapter): void {
  registry.set(adapter.kind, adapter);
}

export type { WorkerEvent, WorkerRunOptions, WorkerRunResult, WorkerAdapter } from "./types";

/**
 * codex 适配器 v2（非交互模式驱动，绝不模拟键盘 —— 需求 6.3）。
 *
 * ── 15.4 前提验证结论（2026-11-20，官方文档 developers.openai.com/codex/sandbox + 本机实测）──
 * `--dangerously-bypass-approvals-and-sandbox`（别名 --yolo）官方说明 "Skip all confirmation
 * prompts and execute commands without sandboxing"——完全不启用沙箱、不走审批。此模式下调度中心
 * 只能从 JSONL 事件流「事后看到」命令（item.started 时命令已在执行），无法在执行前拦截，
 * 硬拦截不可靠。因此本版默认模式改用官方沙箱方式：
 *   `codex exec -s workspace-write`（官方文档原文 "For non-interactive runs, use
 *   codex exec --sandbox workspace-write"）——OS 级沙箱在执行前强制：
 *   写入只限工作区（-C 指定项目目录）与临时目录，系统目录只读（本机实测
 *   `codex sandbox -C <dir> -P :workspace -- sh -c 'echo x > /etc/...'` 报
 *   "Read-only file system"），网络默认关闭（本机实测 NET_BLOCKED）。
 *   本机沙箱实测记录：项目内写入成功；/tmp 可写（workspace-write 默认可写根，官方配置
 *   sandbox_workspace_write.exclude_slash_tmp 可排除）；/etc 写入被拦截。
 * 「危险全权」(danger-full-access) 仅在设置中心显式开启 worker.dangerFullAccess 后使用，
 *   README/设置界面如实标注：该模式下调度中心不具备执行前拦截能力（15.4 不得宣称已硬拦截）。
 *
 * ── 15.4 组合方案实测：on-request 审批（调度中心自动应答）在 codex exec 非交互模式下不可行
 *    （2026-11-20 晚，本机实装 codex-cli 0.167.2；「沙箱 + on-request 审批」按决策停手，证据如下）──
 * 1) flag 层面（`codex exec --help` 全量输出）：
 *    - exec 子命令没有审批策略参数：`-a/--ask-for-approval` 只存在于交互式 `codex` 主命令帮助。
 *    - `--approve-for-me` 帮助原文 "Route approval requests through automatic review using the
 *      workspace-write sandbox"；与 `-s` 为 clap 互斥项，实测组合直接报错
 *      "the argument '--approve-for-me' cannot be used with '--sandbox <SANDBOX_MODE>'"，
 *      即「-s workspace-write + on-request 审批」两个 flag 无法同时出现在 exec 启动参数里。
 *      源码（tag rust-v0.167.2，codex-rs/utils/cli/src/shared_options.rs）：该 flag
 *      conflicts_with_all=["sandbox_mode", ...]，内部注入 approvals_reviewer="auto_review"、
 *      approval_policy="on-request"、sandbox_mode="workspace-write"。
 * 2) 策略层面（源码 codex-rs/exec/src/lib.rs）：headless 模式默认强制
 *    approval_policy=Some(AskForApproval::Never)，仅当 reviewer 为 AutoReview 时才放开。
 *    实测：exec + `-c approval_policy="on-request"` + 模型请求 require_escalated 提权 →
 *    stderr 报 "approval policy is Never; reject command — you cannot ask for escalated
 *    permissions if the approval policy is Never"，-c 覆盖被 harness 覆盖项压掉。
 * 3) 事件层面（`codex exec --json`）：JSONL 事件处理器（exec/src/
 *    event_processor_with_jsonl_output.rs）没有任何审批事件映射；用本地 mock Responses API
 *    供应商实跑 4 组探针（纯沙箱 / -c on-request / --approve-for-me 放行 / --approve-for-me 拒绝），
 *    stdout 全程无审批请求事件。源码（exec/src/lib.rs handle_server_request）：
 *    exec 进程内收到 ServerRequest::CommandExecutionRequestApproval / FileChangeRequestApproval /
 *    ToolRequestUserInput 一律 reject_server_request("command execution approval is not
 *    supported in exec mode ...") —— 审批请求既不暴露给调用方，也无法由调用方程序化应答。
 *    唯一可观测痕迹是事后 item：{"type":"item.completed","item":{...,"type":"command_execution",
 *    ...,"status":"declined"}}。
 * 4) `--approve-for-me` 的裁决方是 codex 内部 guardian 审查子代理（ApprovalsReviewer::AutoReview，
 *    配置别名 guardian_subagent），非调用方固定规则：实测 guardian 放行后提权命令在沙箱外执行
 *    （写 /etc 报 "Permission denied"，即真实文件系统权限而非 landlock 拦截），guardian 拒绝则
 *    declined；两种结果调度中心都只能事后从状态看到，无法注入 §15 硬拦截规则，且每轮审批多耗
 *    一次模型调用。不满足 15.3「固定规则判断、不依赖大模型」的要求。
 * 5) 官方可编程审批面是 `codex app-server`（JSON-RPC over stdio，本机可用）：服务端向客户端发
 *    ServerRequest（v1 已废弃名 execCommandApproval / applyPatchApproval；现行
 *    CommandExecutionRequestApproval / FileChangeRequestApproval），客户端回 ReviewDecision
 *    —— 若未来要实现「调度中心自动应答审批」，需把工人接入方式从 `codex exec` 子进程改为
 *    app-server 客户端，属架构调整，需使用者重新决策。
 * 结论：维持 `-s workspace-write` 纯沙箱方案（OS 级执行前强制）；本文件不新增审批 flag。
 *
 * ── 命令依据（2026-11-20 本机 `codex exec --help`，codex-cli 0.169.0；与官方沙箱文档相互印证。
 *    晚间复核时本机实装版本为 0.167.2，上述 flag 与事件结构逐项复核一致，见上方审批实测一节）──
 * - `codex exec [OPTIONS] [PROMPT]`：官方说明 "Run Codex non-interactively"。
 * - 提示词可经 stdin 传入：帮助原文 "If not provided as an argument (or if `-` is used),
 *   instructions are read from stdin." —— 我们始终走 stdin，避免 Windows 命令行引号/换行转义问题。
 * - `-C, --cd <DIR>`：指定工人工作根目录（= 项目目录，配合 workspace-write 沙箱限定可写范围）。
 * - `--json`：帮助原文 "Print events to stdout as JSONL"，用于流式读取进度事件。
 * - `--skip-git-repo-check`：帮助原文 "Allow running Codex outside a Git repository"。
 * - `-s, --sandbox <SANDBOX_MODE>`：possible values: read-only | workspace-write | danger-full-access。
 * - 网络放行：官方配置文档 `[sandbox_workspace_write] network_access = true`（默认关）。
 *   工人需要安装依赖/联网下载，因此默认通过 `-c sandbox_workspace_write.network_access=true` 放行
 *   （可在设置中心关闭 worker.sandboxNetworkAccess）。
 * - `-m, --model <MODEL>`、`-c, --config <key=value>`：模型与配置覆盖（帮助原文同前版核对）。
 * - 续聊：`codex exec resume [SESSION_ID] [PROMPT]`（0.167.2 resume --help 与本版 exec 帮助一致）。
 * - ⚠ 教训沿用：codex exec 没有 --full-auto 参数（--help 全量参数列表中不存在）。
 *
 * ── JSONL 事件结构依据（2026-11-16 本机实跑 `codex exec --json` 捕获的真实输出，0.169.0 相同）──
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"..."}}
 *   {"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"..."}}
 *   {"type":"item.started","item":{"id":"item_3","type":"command_execution","command":"...","aggregated_output":"","exit_code":null,"status":"in_progress"}}
 *   {"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"...","aggregated_output":"hello\n","exit_code":0,"status":"completed"}}
 *   {"type":"turn.completed","usage":{...}}
 *   失败时：{"type":"error","message":"..."}、{"type":"turn.failed","error":{"message":"..."}}
 */
import { spawn, ChildProcess, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkerAdapter, WorkerEvent, WorkerRunOptions, WorkerRunResult } from "./types";
import { getConfig } from "../config";
import { classifyCommand } from "../policy/permissions";
import { info, warn } from "../logger";
import { toolsDir } from "../util/paths";

/** 工人回报「问题在调度侧」的约定前缀（需求 8.3，写进工人提示词并加测试）。 */
export const DISPATCH_BLOCKED_PREFIX = "DISPATCH_BLOCKED:";

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
    let stopped = false;
    const result = this.pump(child, opts, lastMsgFile);
    return {
      // 暂停/取消语义（需求 6.4）：先发停止信号，最多等 10 秒，仍未退出则强制结束整个进程树
      stop: () => {
        stopped = true;
        this.stopTree(child, 10000);
      },
      result,
    };
  }

  /** 结束工人进程树：SIGTERM → 最多等 10 秒 → SIGKILL/Windows taskkill /T /F（需求 6.4）。 */
  private stopTree(child: ChildProcess, waitMs: number): void {
    if (child.killed || child.exitCode !== null) return;
    const pid = child.pid;
    try {
      if (process.platform === "win32" && pid) {
        // Windows：结束全部子进程（需求 6.4）
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
      } else {
        try {
          if (pid) process.kill(-pid, "SIGTERM"); // detached 进程组
        } catch {
          child.kill("SIGTERM");
        }
      }
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (child.exitCode !== null) return;
      try {
        if (process.platform === "win32" && pid) {
          execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
        } else if (pid) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      } catch {
        /* ignore */
      }
    }, waitMs);
  }

  /**
   * 计算可执行文件与启动参数。
   * Windows 上 npm 安装的工人是 .cmd 启动器（需求 2.4），必须经 shell 方式启动，
   * Node 直接 spawn .cmd 会因 EINVAL 安全策略失败。
   */
  private resolveExecutable(): string {
    const cfg = getConfig().worker;
    if (cfg.executablePath) return cfg.executablePath;
    // 优先用调度中心便携安装的 codex（需求 6.7 便携安装）
    const portableBin = path.join(toolsDir(), "npm", "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
    if (fs.existsSync(portableBin)) return portableBin;
    return process.platform === "win32" ? "codex.cmd" : "codex";
  }

  /** 拼接 exec/resume 的完整参数与最后消息文件路径（依据见文件头注释）。 */
  private buildCommand(opts: WorkerRunOptions, resumeThreadId?: string): { exe: string; args: string[]; lastMsgFile: string } {
    const cfg = getConfig().worker;
    const args: string[] = ["exec"];
    if (resumeThreadId) {
      args.push("resume", resumeThreadId);
    }
    args.push("--json");
    args.push("--skip-git-repo-check");
    args.push("-C", opts.projectDir);
    // 沙箱模式（15.4 结论）：默认 workspace-write（官方非交互推荐）；显式开启 dangerFullAccess 才用
    // danger-full-access（无沙箱，调度中心无法执行前拦截，README 已如实标注）。
    if ((cfg as any).dangerFullAccess === true) {
      args.push("-s", "danger-full-access");
      warn("codex", "工人使用 danger-full-access（无沙箱）——执行前拦截不可用，已由使用者在设置中心确认");
    } else {
      args.push("-s", "workspace-write");
      // 官方配置 [sandbox_workspace_write] network_access（默认关）；工人安装依赖需要联网，
      // 默认放行，可在设置中心关闭（worker.sandboxNetworkAccess=false 时不加该覆盖）。
      if ((cfg as any).sandboxNetworkAccess !== false) {
        args.push("-c", "sandbox_workspace_write.network_access=true");
      }
    }
    // 工人走中转/自定义 provider 时通过 -c 覆盖（依据：-c, --config <key=value> 帮助项；
    // 值不写 TOML 引号，依赖其 "解析失败则按原始字符串" 的回退行为，规避 Windows 引号转义问题）
    if (cfg.baseUrl) {
      args.push("-c", "model_providers.dispatch.name=dispatch");
      args.push("-c", `model_providers.dispatch.base_url=${cfg.baseUrl}`);
      args.push("-c", "model_providers.dispatch.env_key=DISPATCH_WORKER_API_KEY");
      args.push("-c", "model_provider=dispatch");
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
    // Windows 下 .cmd 启动器必须经 shell 启动（需求 2.4）；整条命令行手工加引号
    const useShell = process.platform === "win32";
    // posix 用 detached 让工人成为进程组长，便于结束后结束整个进程树（需求 6.4）
    const child = useShell
      ? spawn(joinCommand(exe, args), { shell: true, cwd: opts.projectDir, env })
      : spawn(exe, args, { cwd: opts.projectDir, env, detached: true });
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
    let spawnError = false;

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
              // 观测到危险命令：立即终止工人进程树（沙箱模式下系统目录写入本身已被拦截，
              // 此终止用于快速止损与记录；无沙箱模式下此为事后止损，非执行前拦截）
              warn("codex", `发现危险命令，立即终止工人进程树: ${cmd}`);
              this.stopTree(child, 0);
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
        spawnError = true;
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

    // 工人回报通道（需求 8.3）：最后消息里有 DISPATCH_BLOCKED: 开头的行 → 转入调度侧缺陷处理
    const blockedLine = lastMessage
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith(DISPATCH_BLOCKED_PREFIX));

    const ok = !turnFailed && !errMsg && !killedForBlock && !spawnError && child.exitCode === 0;
    return {
      ok,
      lastMessage,
      threadId,
      error: errMsg,
      dispatchBlocked: blockedLine ? blockedLine.slice(DISPATCH_BLOCKED_PREFIX.length).trim() : undefined,
    };
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
            // 权限裁决：固定规则，不依赖大模型（需求 15.3）
            const { verdict, rule } = classifyCommand(cmd, opts.mode);
            if (verdict === "block") {
              opts.onEvent({ kind: "permission", verdict: "block", command: cmd, ruleId: rule?.id, ruleLabel: rule?.label });
              hooks.onBlock(cmd, rule?.id ?? "", rule?.label ?? "");
              return;
            }
            if (verdict === "ask" && !running) {
              // 分级模式：出现需询问的命令 → 终止本轮等待用户决策（L5）
              opts.onEvent({ kind: "permission", verdict: "ask", command: cmd, ruleId: rule?.id, ruleLabel: rule?.label });
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

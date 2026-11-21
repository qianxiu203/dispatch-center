# 调度中心 v2

大脑（LLM）驱动工人（codex CLI）自动完成开发任务的本地服务：使用者只通过对话提出需求，
大脑负责理解需求、复述需求并生成「可自动检查的验收标准」、拆解步骤并指挥工人执行；
全部步骤完成后自动验收，验收通过才算完成。任何自动重试、修复、再生成都有**明确预算与停止去向**，
绝不无限循环。本版本（v2.0）按 `REQUIREMENTS-v2.md` 完整实现，不分期。

- 形态：本地后端服务（Node.js 内置 http，零框架）+ 网页界面（三栏布局）
- 只监听 `127.0.0.1`，不对外网开放；每次启动生成随机访问令牌（`data/runtime.json`）
- 技术栈：**Node.js 22 + TypeScript**（后端零框架，前端 esbuild 打包，Playwright 做自动验收）

## 启动方法

```bash
./start.sh         # Linux / macOS / Windows Git Bash 通用
DISPATCH_NO_BROWSER=1 ./start.sh   # 只启动服务，不自动开浏览器
```

`start.sh` 会自动安装依赖、构建、生成配置模板，然后启动服务并从 `data/runtime.json`
读取端口与本次访问令牌，拼出 `http://127.0.0.1:<port>/?token=<token>` 自动打开浏览器。
按 Ctrl+C 停止服务。

- 端口默认 3210，被占用自动顺延到 3211/3212；实际端口以 `data/runtime.json` 为准。
- 浏览器必须携带令牌（URL 参数、`x-dispatch-token` 头或 cookie 均可），否则接口返回 401。
- 原 Windows 专用 `start.bat` 已废弃并从仓库移除；Git Bash 下直接运行 `start.sh`。

## 配置方法

1. 复制 `config.example.json` 为 `config.json`（程序目录下，已被 `.gitignore` 排除，绝不入库）。
2. 填入大脑配置：`brain.baseUrl`（OpenAI 兼容地址）、`brain.apiKey`、`brain.model`。
3. 也可启动后在网页左栏「设置中心」里直接修改（含「测试连接」按钮）。
4. `worker` 段留空表示工人使用自己的登录配置；填入后通过 `-c` 参数把工人 codex CLI
   指到 OpenAI 兼容中转（参数依据本机 `codex exec --help` 实测 0.169.0；晚间复核时本机
   实装 0.167.2，同批参数逐项复核一致）。
5. 环境体检在设置中心：codex 装到 `tools/npm`、Chromium 下载到 `tools/playwright-browsers`、
   Windows 的 Git 用 MinGit 便携包——全部在程序目录内，不污染系统。

## 需求 15.4 前提验证结论（重要）

需求 15.4 要求：实现前必须先验证「codex 免确认模式下，调度中心能否在执行前拦截工人的命令与路径」。

**结论：免确认模式下不能在执行前拦截，已改用工人 CLI 官方支持的沙箱方式。** 2026-11-20 21:25
使用者决策改用「codex 沙箱 + on-request 审批」组合（工人操作请求审批，调度中心自动应答）；
当晚实测证明该组合在 `codex exec` 非交互模式下不可行（验证过程见第 4 点），已按预先约定停手，
未实现、未宣称实现。当前维持 `-s workspace-write` 纯沙箱方案，需要使用者重新决策。

具体验证过程与依据（codex CLI 0.169.0，官方文档与本机实测）：

1. `codex exec --yolo`（免确认 + 无沙箱）下，工人进程由 codex CLI 自己完成全部命令执行，
   调度中心只在启动前提供提示词、在 stdout 读 JSON 事件——**命令没有经过调度中心的执行前拦截环节**，
   固定规则（需求 15.3 的硬拦截清单）对工人实际执行的命令不生效。实测一个本应硬拦截的命令
   在 `--yolo` 下被直接执行，证明「宣称已硬拦截」不成立。
2. 改用官方支持的沙箱模式：工人统一用 `codex exec -s workspace-write`（官方文档《Sandbox & approvals》，
   默认沙箱即 workspace-write：项目目录内可写、目录外只读、网络默认关闭）。调度中心通过
   `-c sandbox_workspace_write.network_access=true` 显式放行网络；`danger-full-access`（无沙箱）
   只在 config 显式开启 `worker.dangerFullAccess` 且界面上如实标注「无沙箱」时才使用。
3. 权限模式（YOLO/分级）现作用在**调度中心自身的自动化决策**（大脑重试、修复循环、环境安装等）
   与工人提示词约定层面；工人进程内命令由 codex 沙箱约束。需求 15.3 的四类硬拦截规则
   保留在 `src/policy/permissions.ts`，用于调度中心侧的验收命令与自动处理记录展示。
4. **「沙箱 + on-request 审批（调度中心自动应答）」组合实测（2026-11-20 晚，本机实装 codex-cli
   0.167.2，与前述 0.169.0 探针输出逐项一致）：在 `codex exec` 非交互模式下审批请求既不暴露给
   调用方、也无法程序化应答，不可行。** 验了什么、怎么验的、确切 flag/证据：
   - **help 输出**：`codex exec --help` 全量参数里没有审批策略参数（`-a/--ask-for-approval` 只在
     交互式主命令 `codex --help` 里）；审批相关只有 `--approve-for-me`（帮助原文 "Route approval
     requests through automatic review using the workspace-write sandbox"）与
     `--dangerously-bypass-approvals-and-sandbox`。
   - **flag 组合**：`codex exec --approve-for-me -s workspace-write` 直接报错
     `the argument '--approve-for-me' cannot be used with '--sandbox <SANDBOX_MODE>'`——
     「workspace-write + on-request 审批」两个 flag 无法共存；`--approve-for-me` 内部自注入
     `approval_policy="on-request"` + `sandbox_mode="workspace-write"`（0.167.2 源码
     `codex-rs/utils/cli/src/shared_options.rs`）。
   - **审批请求的事件形式**：`codex exec --json` 的 JSONL 事件处理器没有任何审批事件映射
     （0.167.2 源码 `codex-rs/exec/src/event_processor_with_jsonl_output.rs`）；实跑探针
     （本地 mock OpenAI Responses API 供应商驱动，零真实额度）4 组——纯沙箱、`-c
     approval_policy="on-request"`、`--approve-for-me`（审查放行）、`--approve-for-me`（审查拒绝）——
     stdout 全程无审批请求事件。
   - **能否程序化应答**：不能。0.167.2 源码（`codex-rs/exec/src/lib.rs` handle_server_request）：
     exec 进程内收到审批类 ServerRequest 一律自动拒绝，错误信息即
     "command execution approval is not supported in exec mode"；唯一可观测痕迹是事后
     `item.completed` 里 `command_execution` 项的 `status:"declined"`。
   - **实跑样本**：exec + `-c approval_policy="on-request"` 且模型请求提权
     （`sandbox_permissions:"require_escalated"`）→ stderr 明说
     `approval policy is Never; reject command — you cannot ask for escalated permissions if the
     approval policy is Never`——headless 模式强制 Never，`-c` 覆盖无效。
   - **`--approve-for-me` 裁决方**：codex 内部 guardian 审查子代理（配置别名
     `guardian_subagent`），由模型裁决、非调用方固定规则；实测 guardian 放行后提权命令在
     沙箱外执行（写 /etc 报 "Permission denied"，非沙箱报错），拒绝则 `declined`。调度中心
     无法注入 §15 硬拦截规则，且每轮审批额外消耗一次模型调用。不满足 15.3「固定规则判断、
     不依赖大模型」。
   - **可行替代**：`codex app-server`（JSON-RPC over stdio，本机可用）有完整可编程审批面——
     服务端向客户端发 `CommandExecutionRequestApproval` / `FileChangeRequestApproval` 请求
     （v1 已废弃名 `execCommandApproval` / `applyPatchApproval`），客户端回 `ReviewDecision`
     应答。要实现「调度中心自动应答审批」需把工人接入从 `codex exec` 子进程改为 app-server
     客户端，属架构调整，待使用者决策后再排期。

以上属于对需求 15.1「默认 YOLO + 硬拦截」的调整：**硬拦截由「调度中心执行前拦截」改为
「codex 官方沙箱 + 调度侧规则展示」**；「沙箱 + on-request 审批」组合已实测不可行（见第 4 点）。
是否维持当前方案、或改走 `codex app-server` 可编程审批路线，请使用者在阅读本节后重新决策。

## 防循环总原则（需求第 0 节 / 第 4 节）

| 机制 | 说明 |
| --- | --- |
| M1 LoopGuard | 系统里任何「重试、修复、重新生成、轮询、自动回复、自动恢复」都必须先登记预算，每次迭代前 `permit()`，拒绝即走该循环登记的停止去向 |
| M2 进展签名 | 每轮动作的结果算签名（sha1 前 16 位）；EMPTY 签名（内容为空）永不合法 |
| M3 振荡检测 | 最近 8 个签名内同一签名出现 2 次或 A→B→A 判定无进展 |
| M4 精确次数 | 上限 N = 最多执行 N 次动作，第 N 次后仍未成功立即停止（不再发起第 N+1 次） |
| M5 停止去向 | 每个循环在登记时写明触发后的去向：暂停 + 决策卡片，交使用者决定 |
| M6 看门狗 | 任务总时长/工人调用数/单次静默超限即强制暂停并通知 |
| M7 事件因果 | 事件流带 causalId，循环的每一步可追溯 |
| M8 重启恢复 | 任务恢复满 2 次不再自动恢复，暂停 + 决策卡片；计数落盘，重启不重置 |
| M9 大脑重试 | 大脑调用失败退避重试 1s/4s/16s，3 次失败即走停止去向 |
| M10 请求去重 | 同一端点同一 requestId 的连点只执行一次（60 秒窗口） |

L1–L13 为各业务循环的登记表（修复 ≤3、标准重生成 ≤2、问答升级、心跳去重、SSE 补发、
压缩不递归、记忆整理每任务 1 次等），全部在 `src/loop/` 与编排器里落地并落盘。

## 功能一览

| 模块 | 说明 |
| --- | --- |
| 三栏界面 | 左栏项目与设置、中栏聊天与卡片、右栏执行追踪（任务/工人输出/验收/自动处理记录）；<1100px 变抽屉 |
| 流式聊天 | OpenAI 兼容 SSE 解析，增量落盘；断线重连带 lastEventId 补发（V11） |
| 需求确认卡片 | 大脑输出 requirement 后 L2 校验（重生成 ≤2），不合格弹卡片且任务不得创建（V1） |
| 任务状态机 | queued/running/verifying/fixing/waiting_user/paused/passed/failed/cancelled，每任务独立文件落盘 |
| 队列与槽位 | 每个项目同一时刻只执行一个任务，其余排队；暂停的任务不阻塞后续任务 |
| codex 适配器 | `codex exec --json -s workspace-write`，进程树终止、沙箱参数与官方文档一致 |
| 报错修复循环 | L1：同签名 ≤3 次、总修复 ≤6 次、空改动 2 次、签名振荡即停，全部暂停 + 决策卡片（V2/V3/V4） |
| 硬拦截回报 | 工人回报 DISPATCH_BLOCKED 不计修复次数，转调度侧缺陷处理（V14） |
| 自动验收 | Playwright（控制台/未捕获异常/失败请求/HTTP≥400/截图）、file_exists、command_exit_0、web_url |
| 上下文管理 | 压缩阈值 70%，压缩后仍超限截断最旧行，压缩每轮最多一次不递归（V12） |
| 心跳 | 定时体检大脑可达性；同一异常 30 分钟只通知一次（V10） |
| 看门狗 | 静默超限强制暂停并出恢复卡片（V6） |
| 环境安装 | 进度事件、无进度超时中断并换源（镜像→官方→安装器，V9）、可取消 |
| 安全网 | 每任务开始前 git 快照（独立引用 `refs/dispatch/snapshots/<taskId>`），可一键回滚 |
| 目录选择器 | 后端目录浏览（只返回目录名，Windows 列盘符）+ 新建文件夹，重名有提示 |
| 会话管理 | 聊天落盘；新建会话自动归档旧会话；记忆按项目/全局两级存放，任务终态触发一次整理（L13） |
| 诊断包 | `/api/diagnostics` 导出环境与配置，密钥自动脱敏 |

## 测试与 CI

```bash
npm install
npm run build    # tsc 编译后端 + esbuild 打包前端
npm test         # 全部自动化测试（node:test）
```

- 测试全部用「假大脑 + 假工人」（`src/test/helpers.ts`：SSE mock 大脑、可编程 FakeWorker），
  **不消耗任何真实额度**。
- 需求 18.1 的 V1–V14 与 18.2 功能类逐条对应 `src/test/v-loop.test.ts`、`v-infra.test.ts`、
  `v8-restart.test.ts`、`f-functional.test.ts`；逐条结果见 `DEVELOPMENT_REPORT-v2.md`。
- 测试进程的数据目录自动重定向到临时目录，不污染真实 `data/`。
- CI：`.github/workflows/` 同时跑 ubuntu-latest 与 windows-latest 矩阵。

## 目录结构

```
├── src/                 # 后端 TypeScript（server/orchestrator/brain/worker/acceptance/loop/memory/session/policy/tasks/envcheck/toolhub）
├── public/              # 前端（index.html + src/app.ts，构建产物 public/dist）
├── src/test/            # V1–V14 与功能类自动化测试
├── scripts/             # 构建脚本
├── .github/workflows/   # CI（ubuntu + windows 矩阵）
├── start.sh             # 启动入口（Linux / macOS / Git Bash 通用；start.bat 已废弃移除）
├── config.example.json  # 配置模板（config.json 含密钥，gitignore 排除）
├── data/ logs/ tools/   # 运行时数据/日志/便携工具（gitignore 排除）
├── REQUIREMENTS-v2.md   # v2.0 需求文档
└── DEVELOPMENT_REPORT-v2.md # v2 开发报告（含 V1–V14 逐条结果与待确认清单）
```

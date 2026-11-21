# 调度中心 v2 开发报告

依据 `/data/home/dispatch-center/REQUIREMENTS-v2.md`（v2.0，不分期）完成开发。基线为原仓库 HEAD 712adf1，在既有结构上改造，未重写；所有测试使用「假大脑 + 假工人」（mock），未消耗真实额度。

## 一、总体结论

- `npm run build`：通过（tsc + esbuild，输出 public/dist/app.js）。
- `npm test`：**37 过 / 0 挂 / 0 跳过**（Linux 本机）。
- Playwright 浏览器自测：**23 过 / 0 挂**（三栏界面与关键流程，见第六节）。
- 需求 18.1 循环类 V1–V14：**全部通过**（V9 见第 7.4 节，属静态断言）。
- 需求 18.2 功能类：**全部通过**（Windows 一项由 CI 覆盖，见第八节）。
- 需求 15.4 前提验证：免确认（--yolo）模式**拦不住**，已改用 codex 官方沙箱（详见第三节）。

## 二、做了什么

### 2.1 新增模块（沿用既有命名与分层习惯）

| 模块 | 职责（对应需求节） |
| --- | --- |
| `src/loop/loopguard.ts` | 防循环预算登记与 permit/deny（M1–M3、M5，需求第 4 节），全部记录日志 |
| `src/loop/signature.ts` | 任务签名（sha1 前 16 位）与问题签名（含空问题 EMPTY 签名，R3） |
| `src/memory/memory.ts` | 长期记忆（新增/更新/删除三动作、按项目隔离、L13 整理，需求 9.4–9.5） |
| `src/session/store.ts` | 会话与消息落盘（按项目隔离、归档、压缩与回显，需求 9.1–9.3） |
| `src/toolhub/toolhub.ts` | MCP 与 skills 清单接入（需求第 12 节） |
| `src/watchdog.ts` | 看门狗（总时长/调用次数/静默三类上限，V6，需求第 4 节） |
| `src/heartbeat.ts` | 心跳检测（间隔 5 分钟、失败只通知一次，V10，需求第 10 节） |
| `src/brain/criteria.ts` / `src/brain/extract.ts` | 验收标准生成/重生成与结构化抽取（需求 8、L2） |

### 2.2 改造既有文件

- `src/orchestrator.ts`：v2 主编排——任务状态机（queued/running/verifying/fixing/waiting_user/paused/passed/failed/cancelled）、修复循环（同问题 ≤3 次、单任务 ≤6 次）、振荡 guard（L1-sigs）、空改动 guard（V3）、DISPATCH_BLOCKED 分流（V14）、决策卡片（openCard/settleCard）、重启恢复（V8，计数持久化不重置）、压缩检查与压缩后超限处理（V12）、忙碌分流（7.2 意图分类）。卡片事件统一携带 `projectDir`。
- `src/server.ts`：接口按需求第 14 节扩展（任务暂停/恢复/取消/移除/回滚、会话、记忆、心跳、诊断包、卡片查询等）；`/api/cards`、`/api/state` 携带 projectDir；M10 防连点去重键区分端点（`chat:`、`confirm:` 前缀，V13）。
- `src/worker/codex.ts` 与 `types.ts`：统一 `codex exec --json -s workspace-write`（官方文档核对，注释内写明依据）；`danger-full-access` 仅在 config 显式开启 `worker.dangerFullAccess` 时使用。
- `src/acceptance/runner.ts`：验收报告统一产出 results / problems / harnessErrors 三类记录（V1、R2、R4 的基础）。
- `src/config.ts`、`src/envcheck/check.ts`、`src/util/paths.ts`、`src/logger.ts`、`src/main.ts`、`src/brain/brain.ts`、`src/tasks/store.ts`：配套改造（数据目录、日志滚动、事件流断线补发等）。
- `public/`（index.html / app.ts / style.css）：三栏布局（13.1 左右栏固定、中栏独立滚动）、首次引导 5 步（可走通/跳过/重看）、设置中心（权限模式、规则清单、记忆、MCP、心跳条目）、目录选择器与冲突提示、需求确认卡片与决策卡片渲染、任务时间线与暂停/恢复/取消/移除/回滚按钮、会话下拉（含归档会话可再次打开，需求 9.2）、移动端抽屉。
- `start.sh`：重写为 Linux 与 Windows Git Bash 双平台可跑；`start.bat` 按需求第 2 节 `git rm` 删除（未再维护）。
- `config.example.json`：按 v2 配置项重写（大脑接口、工人沙箱、看门狗默认值等）。`config.json` 未做任何改动、不入库（.gitignore 已排除）。

### 2.3 测试文件

一期 `src/test/a1–a9` 已由 v2 测试取代：`v-loop.test.ts`（10 项，V1–V5/V7/V14/R1–R4）、`v-infra.test.ts`（8 项，V6/V9–V13 及契约）、`v8-restart.test.ts`（3 项，V8 三场景）、`f-functional.test.ts`（20 项，功能类与接口契约）。合计 37 项（另 4 项子断言并入主用例计数）。

## 三、需求 15.4 前提验证结论

**免确认模式下，调度中心不能在执行前拦截工人的命令与路径；硬拦截方案不成立，已改用工人 CLI 官方支持的沙箱方式，需要使用者对权限策略重新决策。**

验证依据（codex CLI 0.169.0，官方文档与本机实测，调研缓存已清理）：

1. `codex exec --yolo`（免确认 + 无沙箱）下，工人进程内命令由 codex CLI 自行执行，调度中心只在启动前给提示词、在 stdout 读 JSON 事件——命令不经过调度中心的执行前环节，15.3 固定规则对工人实际执行的命令不生效。实测本应硬拦截的命令在 `--yolo` 下被直接执行。
2. 改用官方沙箱：工人统一 `codex exec -s workspace-write`（官方文档《Sandbox & approvals》：项目目录内可写、目录外只读、网络默认关闭）；网络经 `-c sandbox_workspace_write.network_access=true` 显式放行；`danger-full-access` 仅在 config 显式开启 `worker.dangerFullAccess` 且界面如实标注时使用。
3. 权限模式（YOLO/分级）现作用于调度中心自身的自动化决策与提示词约定层；工人进程内命令由 codex 沙箱约束；15.3 四类硬拦截规则保留于 `src/policy/permissions.ts`，用于调度侧命令与「自动处理记录」展示。

**该结论已写入 README.md「需求 15.4 前提验证结论（重要）」一节**，并明确请使用者重新决策（接受本方案，或要求改用其它沙箱/审批组合，例如沙箱 + `on-request` 审批模式）。按需求 15.4 要求，此处不宣称「已硬拦截」。

> **2026-11-20 晚后续**：使用者决策改用「沙箱 + on-request 审批」组合，当晚实测证明该组合在
> `codex exec` 非交互模式下不可行，已停手未实现，详见第十一节。

## 四、V1–V14 逐条结果（需求 18.1，全 mock）

| 项 | 用例位置 | 注入方式 | 结果 | 实测要点 |
| --- | --- | --- | --- | --- |
| V1 | v-loop.test.ts | 标准 objects 缺 `path` | ✅ 过 | 工人调用数 0；大脑重生成恰好 1 次；仍缺则暂停并出现决策卡片 |
| V2 | v-loop.test.ts | 验收恒失败、问题签名恒定 | ✅ 过 | 第 3 次修复后暂停；工人调用数**恰好 3**（上限差一问题已修，见 R3） |
| V3 | v-loop.test.ts | 工人每次不改任何文件 | ✅ 过 | 连续 2 次空改动即暂停 |
| V4 | v-loop.test.ts | 签名 A、B、A 振荡 | ✅ 过 | A 第二次出现即暂停（L1-sigs 全局序列，不依赖计数器） |
| V5 | v-loop.test.ts | 失败但 problems 与 harnessErrors 均空 | ✅ 过 | 工人调用数 0，任务暂停（不再凭空派工人） |
| V6 | v-infra.test.ts | 工人无任何输出（测试把静默上限调小） | ✅ 过 | 超过静默上限强制暂停 |
| V7 | v-loop.test.ts | 工人重复问同一问题 | ✅ 过 | 大脑只代答 1 次，第 2 次升级给使用者（决策卡片） |
| V8 | v8-restart.test.ts | 反复崩溃 + 重启程序 | ✅ 过 | 第 2 次恢复失败后暂停；重启程序不重置计数（持久化验证） |
| V9 | v-infra.test.ts | Chromium 下载无进度 | ✅ 过 | 静态断言（见第 7.4 节说明）：60 秒无进度中断换源、3 次后报失败的逻辑已实现并有单测覆盖常量与分支 |
| V10 | v-infra.test.ts | 心跳持续失败 | ✅ 过 | 只通知一次、30 分钟内不重复、不唤醒大脑、不重启工人 |
| V11 | v-infra.test.ts | SSE 断线重连补发 | ✅ 过 | finished/序号去重，补发事件不重复处理 |
| V12 | v-infra.test.ts | 压缩后仍超限 | ✅ 过 | 不递归压缩，降级为提醒 |
| V13 | v-infra.test.ts | 快速连点「创建任务」 | ✅ 过 | M10 去重（键带端点前缀）只产生一个任务 |
| V14 | v-loop.test.ts | 工人回报 DISPATCH_BLOCKED | ✅ 过 | 不计入修复次数，转入调度侧缺陷处理（通知 + 等待） |

**V1–V14 全部通过，无不合格项。**

## 五、功能类逐条结果（需求 18.2，全 mock）

| 验收项 | 用例位置 | 结果 |
| --- | --- | --- |
| 契约测试：前端所有接口调用都能在后端找到且方法一致（14.2） | f-functional.test.ts | ✅ 过（静态抽取 public/src/app.ts 的 api() 调用与 server.ts 路由表比对） |
| 刷新页面后聊天记录仍在；流式中途刷新不丢内容 | f-functional.test.ts | ✅ 过（会话消息落盘，重取一致） |
| 暂停的任务不阻塞新任务；可暂停/恢复/取消/移除/回滚 | f-functional.test.ts | ✅ 过（paused/waiting_user 不占执行槽，需求 6.2） |
| 目录选择器可用，冲突路径有提示 | f-functional.test.ts | ✅ 过 |
| 左右栏固定，中栏独立滚动 | UI 自测（样式断言）+ f-functional | ✅ 过 |
| 首次引导 5 步可走通、可跳过、可重看 | UI 自测 | ✅ 过 |
| 新建聊天后，新会话里没有旧项目对话原文 | f-functional.test.ts | ✅ 过（旧会话归档，新会话只带记忆/任务摘要） |
| 环境安装有进度条，能取消 | f-functional.test.ts | ✅ 过 |
| 诊断包导出后不含任何密钥 | f-functional.test.ts | ✅ 过（脱敏断言：API Key 等模式不出现） |
| 无令牌或 Origin 不合法的请求被拒绝 | f-functional.test.ts | ✅ 过（401/403 断言） |
| 15.4 的验证结论已写入 README | 本报告第三节 + README | ✅ 完成 |
| 以上在 Windows（Git Bash）环境全部通过 | GitHub Actions（见第八节） | ⏳ 由 CI 覆盖 |

## 六、浏览器（Playwright）自测结果：23 过 / 0 挂

以「假大脑 + 假工人」启动真实服务后，用 Playwright（chromium，headless）按真实用户操作走通全流程，逐项结果：

| # | 检查项 | 结果 |
| --- | --- | --- |
| 1–3 | 三栏布局 #left / #middle / #right 存在 | ✅ |
| 4 | 右栏七个面板齐全 | ✅ |
| 5–8 | 首次引导：出现、走完关闭、可重看、可跳过 | ✅ |
| 9 | 设置中心打开（含环境体检、记忆、MCP、心跳条目加载） | ✅ |
| 10 | 沙箱提示可见（workspace-write 说明） | ✅ |
| 11–13 | 目录选择器打开、添加项目、标题切换 | ✅ |
| 14–15 | 需求确认卡片出现、含需求与验收标准 | ✅ |
| 16 | user 消息气泡恰好一条（排除双渲染） | ✅ |
| 17 | 确认开工后任务执行到完成（时间线「已通过」） | ✅ |
| 18 | 产物 index.html 落在项目目录 | ✅ |
| 19 | 右栏任务时间线有任务 | ✅ |
| 20–21 | 窄屏（375px）面板切换按钮与抽屉 | ✅ |
| 22 | 会话下拉含归档会话（2 个选项，可再次打开） | ✅ |
| 23 | 浏览器控制台零报错 | ✅ |

自测过程中发现并修复了三个真实产品问题（均先复现、修复后复测通过）：

1. 会话区重建（session-update 事件触发）会清空聊天区，SSE 先渲染的打开中卡片因此丢失——改为重建时从服务端拉取当前打开卡片恢复，且去重集合同步重置；
2. 设置中心任一信息加载失败会导致弹窗打不开——改为先弹窗再加载，失败仅提示；
3. 会话下拉把归档会话过滤掉了，与需求 9.2「可在会话列表查看、可再次打开」冲突——已放开。

## 七、Linux 测试结论与跳过说明

`npm test` 共 **37 项：37 过 / 0 挂 / 0 跳过**（本机 Linux，2026-11-20）。**没有任何用例被跳过**，因此无需说明跳过原因。V9 为静态断言（见下）。原一期测试中的 a5-codex（真实 codex 登录任务）类用例未带入 v2——v2 全量使用假工人，不依赖真实额度，CI 中也不再有自动跳过项。

### 7.4 静态断言说明（V9）

V9 的「60 秒无进度中断并换源、3 次后报告失败」依赖真实网络下载行为，mock 环境下无法真实触发下载卡顿，故采用静态断言：验证实现中存在对应常量、换源列表与重试分支，并由单测确认分支逻辑（进度回调、源轮换、次数上限）。这是本版唯一采用静态断言的验收项，已在待确认清单（7.2）中列明，供使用者决定是否要求补充真实网络集成测试。

## 八、GitHub Actions 工作流改动（单独说明）

文件：`.github/workflows/test.yml`（本次已改动；因推送工作流文件需要走 GitHub 网页端确认，尚未推送，提交仅在本地）。

- 矩阵沿用 `windows-latest + ubuntu-latest` 双环境（先于本任务已配好，本次确认保留）。
- 测试步骤名由一期「A1-A10」更新为 v2 口径：「运行测试（v2 全量 37 项：假大脑+假工人，不消耗真实额度）」。
- `npm test` 在 v2 下无环境依赖跳过项，Windows 环境全量执行；`PLAYWRIGHT_BROWSERS_PATH` 指向仓库 tools 目录，验收用 Chromium 由工作流步骤 `npx playwright install chromium` 下载。
- **需要使用者在网页端确认后推送本仓库以触发双系统 CI**（本任务按要求未推送）。

## 九、遗留问题与待确认清单

### 9.1 需要使用者重新决策（按需求文档明确要求上报）

1. **15.4 权限策略（最重要）**：免确认模式拦不住，已改用 codex 官方沙箱（workspace-write）。是否接受「codex 沙箱 + 调度侧规则展示」作为最终方案？如需更强约束，可选沙箱 + `on-request` 审批模式（工人操作会请求审批，由调度中心自动应答——**该组合已于 2026-11-20 晚实测：`codex exec` 模式下不可行，见第十一节；可行替代为 `codex app-server` 可编程审批，属架构调整，需重新决策**）。
2. **CI 推送**：工作流文件改动需网页端确认后推送，才能让 Windows 覆盖生效。

### 9.2 口径与实现的已知边界（不阻塞验收，供后续版本决策）

1. **V2 口径**：「零步骤任务」在 v2 视为创建期校验失败（不允许创建），因此 V2 用例以「工人调用恰好 3 次」为准；若需要「零步骤也走 3 次修复」口径请告知。
2. **V1 regen 上限**：需求 18.1 V1 写「不超过 1 次」，需求第 4 节 L2 缺 path 重生成上限为 2——两处按 V1 从严取 1，其余 L2 场景（如 R1）维持 2。两节口径建议后续统一。
3. **V9 静态断言**：见 7.4，是否要求真实网络集成测试。
4. **L2 预算存储**：循环预算使用进程内 Map + 任务文件持久化计数，多进程部署（当前为单进程服务）不适用；单进程场景无影响。
5. **安装取消语义**：环境安装取消采用终止子进程 + 状态回滚；子进程已产生的外部副作用（如已下载一半的工具目录）由下次安装清理。
6. **假大脑路由**：mock 大脑按最后一条 user 消息关键词路由（requirement/plan/regen/memory_consolidation/summary），与真实大脑协议一致但仅覆盖测试路径。

### 9.3 本次开发中另行的守规说明

- `config.json` 全程未改动、未入库；`.gitignore` 排除已确认。
- 未推送 GitHub；所有提交仅在本地，中文提交信息。
- start.bat 已 `git rm`（提交待使用者推送到远端时同步删除）。
- 一期需求文档 `REQUIREMENTS.md`、`DEVELOPMENT_REPORT.md` 保留作为对照，未删除。

## 十、交付物清单

- 源码与前端：见第二节文件清单（git 提交记录为最终口径）。
- 测试：`src/test/v-loop.test.ts`、`v-infra.test.ts`、`v8-restart.test.ts`、`f-functional.test.ts`、`helpers.ts`。
- 文档：`README.md`（含 15.4 结论）、`DEVELOPMENT_REPORT-v2.md`（本文）、`config.example.json`。
- 需求文档 `REQUIREMENTS-v2.md` 已入库。
- CI：`.github/workflows/test.yml`（双系统）。
- 启动脚本：`start.sh`（Linux + Windows Git Bash）；start.bat 已删除。

## 十一、2026-11-20 晚：「沙箱 + on-request 审批」组合实测（结论：exec 模式不可行，已停手）

按 2026-11-20 21:25 使用者决策，尝试实现「工人以 workspace-write 沙箱运行 + 开启 on-request
审批，调度中心收到审批请求后按 §15 策略自动应答（硬拦截项拒绝、其余放行）」。实现前按任务要求
先实测前提，**实测结论：在 `codex exec` 非交互模式下审批请求既不暴露给调用方、也无法程序化应答，
组合不可行。已按预先约定立即停手，未实现、未宣称实现；调度中心默认行为维持纯沙箱不变。**

### 11.1 本机实装版本澄清

- 任务描述写「codex 0.169.0」；本机当前实装为 **codex-cli 0.167.2**（`codex --version`，
  npm 全局包 `@openai/codex@0.167.2`）。本次全部结论以 0.167.2 的 help 输出、同版本源码
  （GitHub tag `rust-v0.167.2`）与本机实跑为准；0.167.2 的 `codex exec --help` flag 列表
  与既有 0.169.0 探针记录逐项一致。

### 11.2 实测方法（零真实额度）

- 用本地 Node 起 mock OpenAI Responses API 供应商（SSE 流式），经
  `-c model_providers.mock.base_url=http://127.0.0.1:44057/v1` 指给 codex；
  模型首回合脚本化返回 `exec_command` 工具调用（写 /etc 的越权命令，可带
  `sandbox_permissions:"require_escalated"` 提权参数）；guardian 审查请求靠请求体里的
  `text.format.schema`（`outcome: allow|deny` 裁决 schema）识别并脚本化应答。所有请求落盘留证。
- 4 组探针：A 纯沙箱基线；B exec + `-c approval_policy="on-request"`；C `--approve-for-me`
  （guardian 放行）；D `--approve-for-me`（guardian 拒绝）。另测 flag 组合冲突（不需 API）。

### 11.3 证据清单

1. **flag 层面**：`codex exec --help` 全量输出无审批策略参数（`-a/--ask-for-approval` 仅在
   交互式主命令帮助中，取值 on-request|never）；审批相关仅 `--approve-for-me` 与
   `--dangerously-bypass-approvals-and-sandbox`。实测
   `codex exec --approve-for-me -s workspace-write` 报错
   `error: the argument '--approve-for-me' cannot be used with '--sandbox <SANDBOX_MODE>'`
   ——「沙箱 flag 与审批 flag 同时存在」在参数层就不成立（源码
   `codex-rs/utils/cli/src/shared_options.rs`：`conflicts_with_all=["sandbox_mode", ...]`）。
2. **策略层面**：0.167.2 源码 `codex-rs/exec/src/lib.rs`：headless 默认强制
   `approval_policy: Some(AskForApproval::Never)`。实测 B 组：模型请求提权 → stderr
   `approval policy is Never; reject command — you cannot ask for escalated permissions if the
   approval policy is Never`，`-c` 覆盖被压掉。
3. **事件层面**：`codex exec --json` 事件处理器（`codex-rs/exec/src/
   event_processor_with_jsonl_output.rs`）无任何审批事件映射；4 组探针 stdout 均无审批事件。
   源码 `handle_server_request`：exec 进程内收到 `CommandExecutionRequestApproval` /
   `FileChangeRequestApproval` / `ToolRequestUserInput` 一律
   `reject_server_request("command execution approval is not supported in exec mode ...")`。
   唯一痕迹：D 组事后 `item.completed` 中 `command_execution` 项 `status:"declined"`。
4. **裁决方**：`--approve-for-me` 的审批由 codex 内部 guardian 审查子代理裁决
   （`ApprovalsReviewer::AutoReview`，配置别名 `guardian_subagent`）：C 组 guardian 放行后
   提权命令在沙箱外执行（写 /etc 报 `Permission denied`，真实文件系统权限；对照 A 组沙箱内
   为 `Read-only file system`），D 组拒绝则 declined。调度中心无法注入 15.3 固定规则，
   且每轮审批多耗一次模型调用。

### 11.4 本次实际改动（仅记录，无功能变更）

- `src/worker/codex.ts`：文件头注释新增「15.4 组合方案实测」证据块（flag、事件、源码依据、
  替代方案），供后续维护者不再重复踩坑；未改任何运行逻辑。
- `README.md`：15.4 一节更新为「组合实测不可行 + 可行替代」，明确验了什么、怎么验的、确切 flag。
- 本报告：本节 + 第三节/9.1 口径同步。
- 配置与测试：无改动。原 37 项测试（V1–V14 全量）复跑通过，证明无回归。
- 未实现：审批自动应答逻辑、新模式配置开关（前提不成立，不得谎称已实现）。

### 11.5 可行替代方案（需使用者重新决策）

1. **维持现状（当前默认）**：`codex exec -s workspace-write` 纯沙箱——OS 级执行前强制，
   项目内可写、系统目录只读、网络可开关；15.3 硬拦截规则在调度中心侧展示与记录。
2. **`codex app-server` 可编程审批**（官方程序化审批面，本机可用）：工人接入改为 JSON-RPC
   客户端，服务端发 `CommandExecutionRequestApproval` / `FileChangeRequestApproval`
   （v1 名 `execCommandApproval` / `applyPatchApproval`，已标注 DEPRECATED），客户端回
   `ReviewDecision` 应答——可实现「调度中心按 §15 策略自动应答」，属架构调整，需排期。
3. **`--approve-for-me`**：审批存在但由 codex 内部 guardian 模型裁决，不满足 15.3
   「固定规则、不依赖大模型」要求，且放行的提权命令在沙箱外执行——不推荐。

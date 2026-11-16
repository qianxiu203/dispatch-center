# 调度中心第一期 · 开发报告

日期：2026-11-16 · 执行：grok（按 REQUIREMENTS.md 开发，云端 Linux 环境）

## 一、模块清单

| 模块 | 位置 | 要点 |
| --- | --- | --- |
| 后端服务 | `src/server.ts`、`src/main.ts` | 零框架（node:http），只监听 127.0.0.1；默认端口 3210，被占用顺延 3211/3212；静态页面、`/api/*` 接口、SSE 事件流、`/preview/` 项目静态预览 |
| 大脑客户端 | `src/llm/openai.ts`、`src/brain/brain.ts` | OpenAI 兼容接口流式调用；SSE 解析只取 `choices[0].delta.content`（兼容 CRLF/半行/多事件）；大脑 JSON 协议（chat/clarify/requirement/plan）+ 渐进式提取 text 字段实现边生成边显示；120 秒 socket 空闲超时防上游挂死 |
| 编排主循环 | `src/orchestrator.ts` | 需求确认 → 大脑拆步骤 → 逐步骤驱动工人 → 自动验收 → 修复循环（同一错误 3 次上限 → 暂停+决策卡片）→ 全部验收通过才算完成；git 快照/回滚（独立 ref，不污染用户分支）；重启恢复 |
| 任务状态机 | `src/tasks/store.ts` | 8 态 + 迁移表校验，原子落盘 `<项目>/.dispatch/state.json` |
| codex 适配器 | `src/worker/codex.ts` | `codex exec --json` 非交互模式，提示词走 stdin，绝不模拟键盘；参数全部依据 2026-11-16 本机 `codex exec --help` 实测（0.167.2 与便携 0.169.0 双版本核对），**无 --full-auto**（注释中注明教训）；JSONL 事件逐条解析为线程/消息/思考/命令/文件/错误事件 |
| 权限策略 | `src/policy/permissions.ts` | 默认 YOLO 全放行 + 自动处理记录；三类硬拦截（格式化磁盘/删系统目录/改启动与安全设置）固定规则判定、任何模式直接拒绝；分级模式 9 类操作弹决策卡片 |
| 自动验收 | `src/acceptance/runner.ts` | Playwright chromium 抓控制台 error/未捕获异常/失败请求/HTTP≥400 + 截图；file_exists / command_exit_0 / web_url；跨平台命令执行（Windows cmd / Linux sh） |
| 环境体检与便携安装 | `src/envcheck/check.ts` | Node/Git/Python/codex/Chromium 五项中文体检；一键修复全部装进程序目录 `tools/`（codex→tools/npm，Chromium→tools/playwright-browsers，Windows Git→MinGit 便携包），不改系统全局 |
| 前端界面 | `public/` | 三栏布局（项目与设置 / 聊天与卡片 / 执行追踪五面板）；fetch 流式渲染聊天；需求确认卡片、决策卡片；设置中心（大脑配置/测试连接/权限模式/规则清单/体检与一键修复）；移动端适配 |
| 自动化测试 | `src/test/`（9 个文件 23 用例） | A1–A10 逐条覆盖，node:test；测试数据目录隔离、mock 大脑/上游/工人、真实 codex 用例门控 |
| CI | `.github/workflows/test.yml` | windows-latest + ubuntu-latest 双矩阵：install → build → 下载 Chromium → npm test |
| 启动入口 | `start.bat`、`start.sh` | Windows 双击：装依赖→构建→复制配置模板→后台启动→等待 runtime.json 自动开浏览器（`DISPATCH_NO_BROWSER=1` 可跳过） |

## 二、测试结果

命令：`npm install` → `npm run build` → `npm test`，三步全部真实执行通过。

- `npm test`：**23 个用例，21 通过 / 0 失败 / 2 按设计跳过**（A1 真实 start.bat 仅 Windows、A5 真实 codex 需门控），全套约 12 秒。
- `DISPATCH_TEST_CODEX=1`（真实端到端）：**通过** —— 大脑（中转 glm-5.3-flash）拆步骤 → codex 0.169.0 非交互执行 → hello.txt 落在项目目录 → 状态写入 state.json → 验收通过。
- 真实聊天流式：curl 直测 `/api/chat`，SSE 帧内只有提取后的中文文本与 `chat-done`，无任何协议骨架。
- 环境体检：Node/Git/Python/codex/Chromium 五项全 OK（Chromium 经自家 `/api/envcheck/fix` 真实下载修复）。
- 界面 Playwright 自测：21 项全过（三栏、五面板、真实流式聊天、设置中心、工人输出折叠、控制台零报错、移动视口），已截图。
- 服务真跑：`npm start` 启动于 127.0.0.1:3210，`/api/health`、`/api/state`、`/api/envcheck`、`/api/events`、静态页、`/preview/` 均实测正常。

测试驱动出的修复（均已提交）：权限规则尾部 `\b` 在冒号/空格后不成立导致漏拦 `format C:`、`shutdown /r`；
envcheck 未尊重配置的工人路径；状态机缺 `fixing → in_progress` 迁移导致修复中任务无法恢复；
测试服务器监听句柄残留导致测试进程永不退出；a9 密钥扫描误扫二进制与夹具自身。

## 三、未验证项

| 项 | 原因 | 缓解 |
| --- | --- | --- |
| A1 双击 start.bat 真实启动 | 云端是 Linux，无 Windows 真机 | start.bat 关键步骤有静态断言；GitHub Actions windows-latest 会跑全部测试 |
| A10 Windows 全量验收 | 同上 | 同上 |
| start.bat 的「自动打开浏览器」环节 | 同上，且 CI 无桌面 | 已实现为等待 runtime.json 出现后调 PowerShell 打开；`DISPATCH_NO_BROWSER=1` 可跳过 |

其余 A2–A9 与界面自测均已在云端 Linux 真实跑通。

## 四、待确认事项

1. 大脑接入是否仅 OpenAI 兼容接口（默认按文档第 10 节执行）。
2. Python 一期只体检提示，便携安装方式待定（README 待确认事项已记录）。
3. 分级模式批准后当前按「整步重跑（提示词注明已批准）」实现，是否需精确到单条命令放行。
4. 聊天历史落盘但重启后界面暂不回显，是否需要回显。
5. 默认上限（修复 3 次 / 总步数 30 / 总时长 60 分钟）是否合适，均可在设置中心调整。
6. 端口策略：默认 3210，占用顺延 3211/3212，是否符合预期。

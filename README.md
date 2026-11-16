# 调度中心（第一期）

大脑（LLM）驱动工人（codex CLI）自动完成开发任务的本地服务：使用者只通过对话提出需求，
大脑负责理解需求、生成「需求 + 验收标准」、拆解步骤并指挥工人执行；全部步骤完成后自动验收，
验收通过才算完成，工人自己说"做完了"不算。同一错误连续修复 3 次仍不通过则暂停并交由使用者决定。

- 形态：本地后端服务（Node.js 内置 http，零框架）+ 网页界面（三栏布局）
- 只监听 `127.0.0.1`，不对外网开放
- 技术栈按需求文档 3.3 建议：**Node.js 22 + TypeScript**（前后端同语言，后端零框架减少 Windows 环境依赖风险，前端用 esbuild 打包，Playwright 做自动验收）

## 启动方法

### Windows（目标环境）

1. 双击 **`start.bat`**：自动安装依赖 → 构建 → 复制配置模板 → 后台启动服务 → 自动打开浏览器。
2. 需要已安装 Node.js 18+；其余工具（codex CLI、验收用 Chromium）缺失时可在设置中心一键便携安装。

### Linux / macOS（开发环境）

```bash
npm install
npm run build
npm start          # 或 ./start.sh
```

### 端口说明

服务默认监听 **3210**（本机 3000 端口常被其他服务占用，故默认避开）；
若 3210 被占用会自动顺延到 **3211 → 3212**，实际端口写在 `data/runtime.json`，
启动日志也会打印实际地址。可在 `config.json` 里改 `port`。

## 配置方法

1. 复制 `config.example.json` 为 `config.json`（程序目录下，已被 `.gitignore` 排除，绝不入库）。
2. 填入大脑配置：
   - `brain.baseUrl`：OpenAI 兼容接口地址，如 `https://api.0407123.xyz/v1`
   - `brain.apiKey`：API Key（只存本机文件，不写日志、不进仓库；日志输出前会自动脱敏）
   - `brain.model`：模型名，如 `glm-5.3-flash`
3. 也可启动后在网页左栏「⚙ 设置中心」里直接修改（含「测试连接」按钮）。
4. `worker` 段留空表示工人使用自己的登录配置；填入 `baseUrl/model/apiKey` 则通过 `-c` 参数把工人
   codex CLI 指到 OpenAI 兼容中转（responses 协议，已在 0.167.2 / 0.169.0 实测）。
5. 环境体检在设置中心，缺什么点什么：codex 装到 `tools/npm`、Chromium 下载到 `tools/playwright-browsers`、
   Windows 的 Git 用 MinGit 便携包解到 `tools/MinGit`——全部在程序目录内，不污染系统。

## 功能一览（对应需求 5/6/7）

| 模块 | 说明 |
| --- | --- |
| 三栏界面 | 左栏项目与设置、中栏聊天与卡片、右栏执行追踪（任务时间线/工人实时输出/验收结果/控制台报错/自动处理记录） |
| 流式聊天 | 后端解析上游 SSE，只提取 `choices[0].delta.content` 发给前端；协议骨架不透出（A2 覆盖） |
| 需求确认卡片 | 大脑输出 requirement 后弹出确认卡片，确认后才开始拆解执行 |
| 决策卡片 | 修复上限、硬拦截、工人失败、分级询问、重启恢复等场景弹出，使用者点选后继续 |
| 任务状态机 | 8 态（待办/进行中/等待我决定/验收中/修复中/已完成/出错/已暂停），落盘 `<项目>/.dispatch/state.json`，重启可恢复 |
| codex 适配器 | 非交互模式（`codex exec --json`），绝不模拟键盘；参数全部依据本机 `codex exec --help` 实测（0.167.2 / 0.169.0），没有 `--full-auto` 参数 |
| 权限策略 | 默认 YOLO 自动批准 + 自动处理记录；硬拦截三类灾难操作（格式化磁盘/删系统目录/改启动与安全设置），任何模式直接拒绝并通知 |
| 自动验收 | Playwright（控制台 error、未捕获异常、失败请求、HTTP≥400 + 截图）、file_exists、command_exit_0、web_url |
| 报错修复循环 | 验收失败自动把结构化问题发给工人修复；同一错误 3 次上限，超过即暂停 + 决策卡片 |
| 环境体检与便携安装 | Node/Git/Python/codex/Chromium 五项中文体检 + 一键修复到 tools/ 目录 |
| 设置中心 | 大脑配置与测试连接、权限模式切换、规则清单、环境体检与一键修复 |
| 安全网 | 每个任务开始前 git 快照（独立引用 `refs/dispatch/snapshots`，不污染使用者分支），可一键回滚 |

## 验收结果（对应需求文档第 8 节 A1–A10）

自动化测试：`npm test`（node:test，位于 `src/test/`），CI 见 `.github/workflows/test.yml`（windows-latest + ubuntu-latest 矩阵）。

| 项 | 结论 | 说明 |
| --- | --- | --- |
| A1 双击 start.bat 启动并自动开界面 | **未验证（需在 Windows 上验证）** | start.bat 的关键步骤（装依赖/构建/复制配置/后台启动/等待 runtime.json 开浏览器）有静态断言测试；真实双击运行由 GitHub Actions windows-latest 承担 |
| A2 聊天流式输出 | ✅ 通过（云端已验） | 自动测试：mock 上游分片发送，断言 >3 个增量块、到达时间递增、拼出的文本与 text 字段一致、不含任何 SSE/JSON 协议文本；Playwright 实测界面流式渲染正常 |
| A3 产物只落项目目录 | ✅ 通过（云端已验） | 桩工人写文件，前后对比程序目录快照，无新增文件 |
| A4 环境体检中文提示 + 一键便携安装 | ✅ 通过（云端已验） | 5 项体检中文提示；坏路径能发现；codex 真实安装到 tools/npm、Chromium 真实下载到 tools/playwright-browsers 均已在本机跑通 |
| A5 codex 适配器完整任务 | ✅ 通过（云端已验） | 真实链路：大脑拆步骤 → codex 0.169.0 非交互执行 → hello.txt 落在项目目录 → 状态写入 state.json。CI 中因无登录环境自动跳过（`DISPATCH_TEST_CODEX=1` 开启） |
| A6 权限策略 | ✅ 通过（云端已验） | 17 条灾难命令双模式全拦截；YOLO 全放行且记录；分级模式下删除/安装/杀进程等 9 类操作出决策卡片 |
| A7 报错修复循环与上限 | ✅ 通过（云端已验） | 桩工人验证：修好→通过、永不修好→第 3 次后暂停+决策卡片；真实验收器能抓控制台报错/失败请求并截图 |
| A8 重启恢复 | ✅ 通过（云端已验） | 状态文件落盘读回一致；新实例恢复未完成任务为决策卡片，选「继续执行」可完成 |
| A9 日志与仓库无密钥 | ✅ 通过（云端已验） | 哨兵密钥写入日志后断言被脱敏；扫描全部 git 跟踪文件无密钥形态字符串 |
| A10 以上验收在 Windows 全部通过 | **未验证（需在 Windows 上验证）** | 云端为 Linux；Windows 侧由 CI（windows-latest 矩阵）与真机双击 start.bat 验证 |

界面自测（需求 9.2）：已用 Playwright 在云端打开界面逐项检查——三栏布局、五个追踪面板、
真实流式聊天、设置中心（中转地址/模型/规则清单/体检入口）、工人输出折叠展开、浏览器控制台零报错、
移动视口渲染，21 项全部通过并截图。

## 测试与 CI

```bash
npm install        # 安装依赖
npm run build      # tsc 编译后端 + esbuild 打包前端
npm test           # 全部自动化测试（约 12 秒）
DISPATCH_TEST_CODEX=1 npm test   # 额外运行真实 codex 端到端用例（需已配置可用的工人）
```

- 测试进程的数据目录自动重定向到临时目录，不污染真实 `data/`。
- CI：`.github/workflows/test.yml`，windows-latest 与 ubuntu-latest 双矩阵，安装 → 构建 → 下载 Chromium → 跑测试。

## 目录结构

```
├── src/                 # 后端 TypeScript（server/orchestrator/brain/worker/acceptance/policy/tasks/envcheck）
├── public/              # 前端（index.html + src/app.ts，构建产物 public/dist）
├── src/test/            # A1–A10 自动化测试
├── scripts/             # 构建脚本
├── .github/workflows/   # CI
├── start.bat / start.sh # 启动入口
├── config.example.json  # 配置模板（config.json 含密钥，gitignore 排除）
├── data/ logs/ tools/   # 运行时数据/日志/便携工具（gitignore 排除）
└── DEVELOPMENT_REPORT.md # 开发报告
```

## 待确认事项

1. **大脑接入**：按文档第 10 节默认只接 OpenAI 兼容接口（当前用 responses 协议流式）。
2. **Python 便携安装**：一期只检测并提示，未提供一键便携安装（方式待定：WinPython 便携包 / embeddable zip，需确认后补充）。
3. **分级模式批准后的重跑粒度**：当前实现为"批准后整步重跑（提示词注明已批准）"，若需要精确到单条命令放行，需确认后调整。
4. **聊天历史持久化**：聊天记录存于 `data/chat-<hash>.json`（按项目哈希），重启后界面暂不回显历史消息，状态类信息以右栏与状态文件为准；如需界面回显历史请告知。
5. **默认上限**：同一错误修复 3 次、总步数 30、总时长 60 分钟（可在设置中心调整），是否合适待确认。
6. **A1/A10 的 Windows 真机验证**：云端无法执行，依赖 CI 矩阵与真机双击验证。

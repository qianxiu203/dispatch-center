/**
 * A5 验收：能通过 codex 适配器完成一次完整任务：发送需求 → 工人执行 → 状态写入状态文件。
 * 需要 codex CLI 已登录（或已配置可用中转），因此用环境变量 DISPATCH_TEST_CODEX=1 显式开启；
 * CI 与未登录环境自动跳过并在输出中说明（结果以 README 验收结果为准）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Orchestrator } from "../orchestrator";
import { makeTempProject } from "./helpers";
import { setConfigForTest } from "../config";
import { projectStateFile } from "../util/paths";

const enabled = process.env.DISPATCH_TEST_CODEX === "1";

const skipReason = !enabled ? "需 codex 登录环境（设置 DISPATCH_TEST_CODEX=1 开启）" : false;

describe("A5 codex 适配器完整任务", () => {
  test(
    "发送需求 → codex 执行 → 状态写入状态文件",
    { skip: skipReason, timeout: 600000 },
    async () => {
    // 使用本机 config.json 的工人配置（中转/Key 在本机，不进仓库）
    const { loadConfig } = await import("../config");
    loadConfig();
    const cfg = (await import("../config")).getConfig();
    if (cfg.worker.kind !== "codex") setConfigForTest({ worker: { ...cfg.worker, kind: "codex" } });

    const project = makeTempProject("a5");
    const o = new Orchestrator();
    o.openProject(project);
    // 直接以明确的验收标准开工（需求确认环节已在 A2/A7 覆盖）
    const task = await o.startTask("创建 hello.txt，内容为一行文字：你好，调度中心", [
      { id: "C1", text: "存在 hello.txt 且内容包含「你好」", kind: "file_exists", path: "hello.txt" },
    ]);
    for (let i = 0; i < 600 && !["passed", "failed", "paused"].includes(task.status); i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal(task.status, "passed", `codex 任务应完成，实际 ${task.status}；结论: ${task.conclusion ?? task.steps.map((s) => s.detail).join(";")}`);
    assert.ok(fs.existsSync(path.join(project, "hello.txt")), "codex 应在项目目录创建文件");
    assert.ok(fs.existsSync(projectStateFile(project)), "状态文件应写入项目目录");
    const state = JSON.parse(fs.readFileSync(projectStateFile(project), "utf8"));
    assert.equal(state.tasks[0].status, "passed");
    fs.rmSync(project, { recursive: true, force: true });
    },
  );

  test(
    "codex 适配器用实测过的非交互参数（无 --full-auto）",
    async () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "worker", "codex.js"), "utf8");
    // 去掉注释后再扫：文件头允许有"0.167.2 没有 full-auto 参数"的依据说明，
    // 但实际拼参数的代码里绝不允许出现该参数
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.ok(!code.includes("--full-auto"), "不得使用不存在的 --full-auto 参数（0.167.2 已核对）");
    assert.ok(src.includes("--json"), "应使用 --json 事件流（依据 codex exec --help）");
    assert.ok(src.includes("--skip-git-repo-check"), "应使用 --skip-git-repo-check（依据 codex exec --help）");
    assert.ok(src.includes("--dangerously-bypass-approvals-and-sandbox"), "YOLO 应使用绕过审批参数（依据 codex exec --help）");
    assert.ok(src.includes("-C"), "应使用 -C 指定项目目录（依据 codex exec --help）");
  });
});

/**
 * A4 验收：环境体检在缺少某工具时给出明确中文提示，并能一键安装到调度中心自己的目录。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { runEnvCheck, fixTool } from "../envcheck/check";
import { setConfigForTest } from "../config";
import { appRoot, toolsDir } from "../util/paths";

describe("A4 环境体检与便携安装", () => {
  test("体检覆盖 Node/Git/Python/codex/Chromium，缺失项给出中文提示", async () => {
    const results = await runEnvCheck();
    const ids = results.map((r) => r.id);
    for (const expected of ["node", "git", "python", "codex", "chromium"]) {
      assert.ok(ids.includes(expected), `体检应包含 ${expected}`);
    }
    for (const r of results) {
      assert.ok(r.detail.length > 0, `${r.id} 应有说明`);
      // 中文提示（含中文字符）
      assert.ok(/[\u4e00-\u9fa5]/.test(r.detail), `${r.id} 的提示应为中文: ${r.detail}`);
    }
  });

  test("配置的工人路径不存在时，体检能发现并给中文修复说明", async () => {
    setConfigForTest({ worker: { kind: "codex", executablePath: path.join("无", "此", "路径", "codex"), baseUrl: "", model: "", apiKey: "" } });
    const results = await runEnvCheck();
    const codex = results.find((r) => r.id === "codex")!;
    assert.equal(codex.ok, false, "应检测到工人 CLI 不可用");
    assert.ok(/codex/.test(codex.detail) && /[\u4e00-\u9fa5]/.test(codex.detail), `应有中文提示: ${codex.detail}`);
    assert.equal(codex.fixable, true);
    assert.ok(/调度中心|tools/.test(codex.fixDescription ?? ""), `修复说明应指向便携安装: ${codex.fixDescription}`);
    setConfigForTest({ worker: { kind: "codex", executablePath: "", baseUrl: "", model: "", apiKey: "" } });
  });

  test("一键修复的目标目录在调度中心自己的目录内（便携，不污染系统）", () => {
    const tools = toolsDir();
    assert.ok(tools.startsWith(appRoot()), `便携目录应在程序目录内: ${tools}`);
    assert.ok(/tools/.test(path.basename(path.dirname(tools))) || tools.endsWith("tools"));
  });

  test("不支持一键修复的项返回明确中文提示", async () => {
    const r = await fixTool("不存在的工具");
    assert.equal(r.ok, false);
    assert.ok(/[\u4e00-\u9fa5]/.test(r.detail), `应有中文提示: ${r.detail}`);
  });

  test(
    "便携安装真实执行：codex 安装到 tools/npm（已安装时幂等快速通过）",
    { timeout: 600000 },
    async () => {
    // 该用例在已联网环境真实安装；若本机 tools/npm 已存在则校验位置即可
    const fs = await import("node:fs");
    const target = path.join(toolsDir(), "npm", "node_modules", ".bin");
    if (fs.existsSync(path.join(target, process.platform === "win32" ? "codex.cmd" : "codex"))) {
      assert.ok(true, "codex 已便携安装且位置正确");
      return;
    }
    const r = await fixTool("codex");
    assert.equal(r.ok, true, `codex 便携安装应成功: ${r.detail}`);
    assert.ok(fs.existsSync(path.join(target, process.platform === "win32" ? "codex.cmd" : "codex")), "安装后应出现在 tools/npm");
    },
  );
});

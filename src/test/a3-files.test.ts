/**
 * A3 验收：新增项目目录后，执行产生的文件全部在该目录内，调度中心程序目录无新增文件。
 * 用桩工人执行真实文件写入，对比程序目录前后文件集合（排除运行时目录）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Orchestrator, injectWorker } from "../orchestrator";
import { makeTempProject, useMockPlanBrain } from "./helpers";
import { setConfigForTest } from "../config";
import { appRoot } from "../util/paths";

/** 递归收集文件相对路径集合。 */
function listFiles(root: string, excludes: string[]): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs);
      if (excludes.some((e) => rel === e || rel.startsWith(e + path.sep))) continue;
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs);
      else out.add(rel);
    }
  };
  walk(root);
  return out;
}

describe("A3 产物只落在项目目录", () => {
  test("工人执行的文件写入项目目录，调度中心目录无新增", async () => {
    // 大脑拆步骤用 mock 上游，避免依赖真实网络（CI 里没有 config.json）
    const mock = await useMockPlanBrain();
    setConfigForTest({
      worker: { kind: "stub-a3", executablePath: "", baseUrl: "", model: "", apiKey: "" },
      limits: { maxFixAttempts: 3, maxStepsPerTask: 30, maxMinutesPerTask: 60 },
    });
    injectWorker({
      kind: "stub-a3",
      run(opts) {
        // 工人模拟：在项目目录创建网页文件
        fs.writeFileSync(path.join(opts.projectDir, "index.html"), "<h1>demo</h1>");
        fs.mkdirSync(path.join(opts.projectDir, "assets"), { recursive: true });
        fs.writeFileSync(path.join(opts.projectDir, "assets", "app.js"), "console.log(1)");
        opts.onEvent({ kind: "message", text: "已创建文件" });
        return { stop: () => {}, result: Promise.resolve({ ok: true, lastMessage: "done" }) };
      },
    });

    const project = makeTempProject("a3");
    const o = new Orchestrator();
    o.openProject(project);
    // 记录任务开始前的程序目录基线，任务结束后对比新增
    const exclude = ["data", "logs", "tools", "node_modules", "dist", ".git", "config.json"];
    const before = listFiles(appRoot(), exclude);
    const task = await o.startTask("做演示页", [
      { id: "C1", text: "存在 index.html", kind: "file_exists", path: "index.html" },
      { id: "C2", text: "存在 assets/app.js", kind: "file_exists", path: "assets/app.js" },
    ]);
    for (let i = 0; i < 200 && task.status !== "passed" && task.status !== "failed" && task.status !== "paused"; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(task.status, "passed");

    // 项目目录里应有产物
    assert.ok(fs.existsSync(path.join(project, "index.html")));
    assert.ok(fs.existsSync(path.join(project, "assets", "app.js")));

    // 调度中心程序目录无新增文件（运行时目录 data/、logs/、tools/、node_modules/ 除外）
    const after = listFiles(appRoot(), exclude);
    const forbidden = [...after].filter((rel) => !before.has(rel));
    assert.deepEqual(forbidden, [], `调度中心程序目录不应新增文件，实际新增: ${forbidden.join(", ")}`);
    fs.rmSync(project, { recursive: true, force: true });
    mock.close();
  });
});

/**
 * A7 验收：故意产生报错 → 右栏可见 → 自动发给工人修复；
 * 同一错误第 3 次失败后暂停并出现决策卡片。
 * 用桩工人与真实验收器（command_exit_0 / file_exists）确定性验证修复循环与上限。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Orchestrator, injectWorker } from "../orchestrator";
import { makeTempProject, useMockPlanBrain } from "./helpers";
import { setConfigForTest } from "../config";

function stubWorker(kind: string, behavior: (call: number, projectDir: string, prompt: string) => { ok: boolean; file?: boolean; error?: string }) {
  let calls = 0;
  injectWorker({
    kind,
    run(opts) {
      calls++;
      const r = behavior(calls, opts.projectDir, opts.prompt);
      if (r.file) fs.writeFileSync(`${opts.projectDir}/out.txt`, "fixed");
      if (r.error) opts.onEvent({ kind: "fatal", text: r.error });
      return { stop: () => {}, result: Promise.resolve({ ok: r.ok, lastMessage: "stub" }) };
    },
  });
}

describe("A7 报错修复循环", () => {
  test("验收失败自动转修复，工人修好后任务通过", async () => {
    const project = makeTempProject("a7-ok");
    const mock = await useMockPlanBrain();
    setConfigForTest({
      worker: { kind: "stub-a7ok", executablePath: "", baseUrl: "", model: "", apiKey: "" },
      limits: { maxFixAttempts: 3, maxStepsPerTask: 30, maxMinutesPerTask: 60 },
    });
    // 第 1 次执行不建文件（验收失败）；第 2、3 次是修复请求，第 3 次（第 2 轮修复）建好
    stubWorker("stub-a7ok", (call, dir, prompt) => ({
      ok: true,
      file: prompt.includes("修复请求") && call >= 3,
    }));
    const o = new Orchestrator();
    o.openProject(project);
    const task = await o.startTask("创建 out.txt", [
      { id: "C1", text: "存在 out.txt", kind: "file_exists", path: "out.txt" },
    ]);
    for (let i = 0; i < 200 && task.status !== "passed" && task.status !== "failed" && task.status !== "paused"; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(task.status, "passed", `修复后应通过，实际 ${task.status}`);
    assert.ok(fs.existsSync(`${project}/out.txt`));
    assert.ok(Object.keys(task.fixAttempts).length >= 1, "应有修复计数记录");
    fs.rmSync(project, { recursive: true, force: true });
    mock.close();
  });

  test("同一错误连续修复 3 次仍未解决 → 暂停 + 决策卡片", async () => {
    const project = makeTempProject("a7-limit");
    const mock = await useMockPlanBrain();
    setConfigForTest({
      worker: { kind: "stub-a7bad", executablePath: "", baseUrl: "", model: "", apiKey: "" },
      limits: { maxFixAttempts: 3, maxStepsPerTask: 30, maxMinutesPerTask: 60 },
    });
    stubWorker("stub-a7bad", () => ({ ok: true, file: false })); // 永远不建文件，验收永远失败
    const o = new Orchestrator();
    o.openProject(project);
    const task = await o.startTask("创建 out.txt", [
      { id: "C1", text: "存在 out.txt", kind: "file_exists", path: "out.txt" },
    ]);
    for (let i = 0; i < 200 && task.status !== "passed" && task.status !== "failed" && task.status !== "paused"; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(task.status, "paused", `达到上限应暂停，实际 ${task.status}`);
    const card = o.getOpenCards().find((c) => c.payload.decision === "retry_loop");
    assert.ok(card, "应出现修复上限的决策卡片");
    assert.equal(card!.payload.attempts, 3, "决策卡片应记录已修复 3 次");
    assert.deepEqual(card!.payload.options, ["再试一次", "终止任务"]);
    fs.rmSync(project, { recursive: true, force: true });
    mock.close();
  });

  test("验收报错会附结构化信息（页面地址/错误信息/失败请求）", async () => {
    // 用真实验收器抓一个带控制台报错的本地页面
    const { openAndCapture } = await import("../acceptance/runner");
    const { startMockBrokenPage } = await import("./helpers");
    const page = await startMockBrokenPage();
    const cap = await openAndCapture(`http://127.0.0.1:${page.port}/`, { screenshotName: "a7-probe" });
    const kinds = cap.issues.map((i) => i.kind);
    assert.ok(kinds.includes("console") || kinds.includes("pageerror"), "应捕获控制台/页面错误");
    assert.ok(kinds.includes("badstatus") || kinds.includes("requestfailed"), "应捕获失败的网络请求");
    assert.ok(cap.screenshot, "应有截图");
    page.close();
  });
});

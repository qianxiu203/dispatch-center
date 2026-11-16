/**
 * A8 验收：重启程序后可从状态文件恢复未完成的任务。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { TaskStore } from "../tasks/store";
import { Orchestrator, injectWorker } from "../orchestrator";
import { makeTempProject } from "./helpers";
import { setConfigForTest } from "../config";

describe("A8 状态落盘与重启恢复", () => {
  test("任务状态写入项目目录状态文件，重启后可读回", () => {
    const project = makeTempProject("a8");
    const store = new TaskStore();
    store.load(project);
    const task = store.createTask("写一个页面", "做页面", [
      { id: "C1", text: "存在 index.html", kind: "file_exists", path: "index.html" },
    ]);
    store.setStatus(task, "in_progress");
    store.setSteps(task, [{ id: "S1", title: "创建文件", instruction: "创建 index.html", status: "todo" }]);
    store.updateStep(task, "S1", { status: "in_progress" });

    const stateFile = `${project}/.dispatch/state.json`;
    assert.ok(fs.existsSync(stateFile), "状态文件应写入项目目录");

    // 模拟程序重启：全新的 store 实例从状态文件读回
    const store2 = new TaskStore();
    const restored = store2.load(project);
    assert.equal(restored.tasks.length, 1);
    const t2 = restored.tasks[0];
    assert.equal(t2.id, task.id);
    assert.equal(t2.status, "in_progress");
    assert.equal(t2.steps[0].status, "in_progress");
    assert.equal(t2.criteria[0].kind, "file_exists");
    fs.rmSync(project, { recursive: true, force: true });
  });

  test("重启后编排器把未完成任务恢复为决策卡片，选「继续执行」可完成", async () => {
    const project = makeTempProject("a8b");
    setConfigForTest({ worker: { kind: "stub-a8", executablePath: "", baseUrl: "", model: "", apiKey: "" } });
    // 注入桩工人：执行时创建 out.txt
    injectWorker({
      kind: "stub-a8",
      run(opts) {
        fs.writeFileSync(`${opts.projectDir}/out.txt`, "ok");
        opts.onEvent({ kind: "message", text: "done" });
        return { stop: () => {}, result: Promise.resolve({ ok: true, lastMessage: "done" }) };
      },
    });

    // 模拟程序在修复环节被中断（直接落盘为 fixing 状态，模拟异常退出的现场）
    const o1 = new Orchestrator();
    o1.openProject(project);
    o1.store.createTask("恢复测试", "需求", [
      { id: "C1", text: "存在 out.txt", kind: "file_exists", path: "out.txt" },
    ]);
    const task = o1.store.current.tasks[o1.store.current.tasks.length - 1];
    o1.store.forceStatus(task, "fixing");
    o1.store.setSteps(task, [{ id: "S1", title: "建文件", instruction: "建 out.txt", status: "todo" }]);

    // 第二段：模拟重启（新实例从状态文件恢复）
    const o2 = new Orchestrator();
    o2.openProject(project);
    o2.recoverPendingTasks();
    const card = o2.getOpenCards().find((c) => c.payload.decision === "resume_task");
    assert.ok(card, "应出现继续执行的决策卡片");
    assert.equal(card!.payload.taskId, task.id);
    await o2.decide(card!.id, "继续执行");
    // 等待任务循环跑完
    for (let i = 0; i < 100 && !o2.store.getTask(task.id)!.conclusion; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(o2.store.getTask(task.id)!.status, "passed", "恢复后任务应完成");
    fs.rmSync(project, { recursive: true, force: true });
  });
});

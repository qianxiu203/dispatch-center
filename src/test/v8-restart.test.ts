/**
 * V8 重启恢复（M8）：反复崩溃第 2 次恢复失败即暂停；重启程序不重置计数。
 * 以及 18.2「刷新后聊天记录仍在」的持久化回归（会话与任务落盘）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ensureTestDataDir,
  makeTempProject,
  startMockBrain,
  applyTestConfig,
  startTestServer,
  endTest,
  FakeWorker,
  requirementJson,
  planJson,
  fileCriterion,
  api,
} from "./helpers";
import { orchestrator } from "../orchestrator";
import { runAcceptance, type AcceptanceReport } from "../acceptance/runner";

let mock: Awaited<ReturnType<typeof startMockBrain>>;
let port = 0;
let token = "";

before(async () => {
  ensureTestDataDir();
  mock = await startMockBrain();
  applyTestConfig(mock.port);
  const srv = await startTestServer();
  port = srv.port;
  token = srv.token;
  mock.respondWith((lastUser) => {
    if (lastUser.includes("请输出 plan 类型 JSON")) return planJson([{ id: "S1", title: "实现", instruction: "按需求实现" }]);
    if (lastUser.includes("你上一轮给出的验收标准未通过校验")) return requirementJson("重新生成", [fileCriterion()]);
    if (lastUser.includes("请整理记忆")) return JSON.stringify({ type: "memory_consolidation", text: "已整理", add: [], update: [], delete: [] });
    return requirementJson("做一个静态欢迎页", [fileCriterion()]);
  });
});

after(() => {
  endTest();
  mock.close();
});

async function waitFor(pred: () => boolean, timeoutMs = 20000, step = 100): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return pred();
}

// ───────────────────────── V8 第一段：恢复 2 次后停止自动恢复（落盘计数） ─────────────────────────

test("V8 recoverCount≥2 的任务重新打开项目时不再自动恢复（M8）", async () => {
  const project = makeTempProject("v8-a");
  require("node:child_process").execSync("git init", { cwd: project, stdio: "ignore" });
  await api(port, token, "POST", "/api/projects", { path: project });
  const rt = orchestrator.ensureProject(project);
  const task = rt.store.create({ projectId: rt.entry.path, title: "V8 反复崩溃", requirement: "V8", criteria: [fileCriterion()], steps: [] });
  // 模拟已崩溃过一次后再次异常退出：落盘 running + recoverCount=1
  const t1 = rt.store.get(task.id)!;
  t1.recoverCount = 1;
  rt.store.forceStatus(t1, "running", "模拟异常退出时的状态");
  t1.recoverCount = 1;
  rt.store.saveTask(t1);
  // 等效重启：用全新的编排器实例从磁盘加载（服务进程重启后内存态全部来自文件）
  const { Orchestrator } = await import("../orchestrator");
  const o2 = new Orchestrator();
  const rt2 = o2.addProject(project);
  const t2 = rt2.store.get(task.id)!;
  assert.equal(t2.recoverCount, 2, "恢复计数应在原有基础上递增（不重置）");
  assert.equal(t2.status, "paused", `第 2 次恢复应停止自动恢复，实际 ${t2.status}`);
  assert.ok((t2.pausedReason ?? "").includes("恢复") || (t2.pausedReason ?? "").includes("M8"), `暂停原因：${t2.pausedReason}`);
  // 决策卡片不落盘（M8 设计：重启后重新给出决策入口），由新实例打开，直接读 rt2 内存卡片
  const memCards = [...rt2.cards.values()];
  assert.ok(memCards.some((c) => c.payload?.decision === "resume_task"), "应出现恢复决策卡片");
});

// ───────────────────────── V8 第二段：恢复后 60 秒内再崩 → 第 2 次暂停；重启不重置 ─────────────────────────

test("V8 运行期反复崩溃：恢复后 60 秒内再崩即暂停，计数落盘", async () => {
  const project = makeTempProject("v8-b");
  require("node:child_process").execSync("git init", { cwd: project, stdio: "ignore" });
  await api(port, token, "POST", "/api/projects", { path: project });
  const rt = orchestrator.ensureProject(project);
  const task = rt.store.create({ projectId: rt.entry.path, title: "V8 运行期崩溃", requirement: "V8", criteria: [fileCriterion()], steps: [] });
  const worker = new FakeWorker(() => ({}));
  // 模拟「刚被自动恢复过」（M8：恢复后 60 秒内再崩才计数）
  const pre = rt.store.get(task.id)!;
  pre.lastRecoverAt = new Date().toISOString();
  rt.store.saveTask(pre);
  // 故障注入：验收执行直接抛异常（等效运行期崩溃）
  const real = runAcceptance;
  (require("../acceptance/runner") as any).runAcceptance = async (): Promise<AcceptanceReport> => {
    throw new Error("注入的运行期崩溃");
  };
  try {
    orchestrator.pumpQueue(rt);
    // 第 1 次崩溃 → 60 秒窗口内自动恢复（queued）→ 再崩 → 第 2 次 → 暂停
    await waitFor(() => rt.store.get(task.id)!.recoverCount >= 2 || ["paused", "waiting_user"].includes(rt.store.get(task.id)!.status));
    const t = rt.store.get(task.id)!;
    assert.ok(t.recoverCount >= 2, `恢复计数应≥2，实际 ${t.recoverCount}`);
    assert.equal(t.status, "paused", `反复崩溃应暂停，实际 ${t.status}`);
    assert.ok((t.pausedReason ?? "").includes("恢复") || (t.pausedReason ?? "").includes("M8") || (t.pausedReason ?? "").includes("退出"), `暂停原因：${t.pausedReason}`);
    assert.equal(worker.calls.length, 0, "零步骤任务不派工");
  } finally {
    (require("../acceptance/runner") as any).runAcceptance = real;
  }
  // 模拟重启程序：全新编排器实例从磁盘加载；恢复计数来自文件，不重置；已暂停的任务保持暂停
  const { Orchestrator } = await import("../orchestrator");
  const o3 = new Orchestrator();
  const rt3 = o3.addProject(project);
  const t3 = rt3.store.get(task.id)!;
  assert.equal(t3.recoverCount, rt.store.get(task.id)!.recoverCount, "重启后恢复计数不得重置");
  assert.equal(t3.status, "paused", "重启后已暂停任务保持暂停");
});

// ───────────────────────── 正常恢复：崩溃 1 次的任务重启后自动入队并跑完 ─────────────────────────

test("V8 正常路径：异常退出的任务重启后自动恢复入队（队首）并完成", async () => {
  const project = makeTempProject("v8-c");
  require("node:child_process").execSync("git init", { cwd: project, stdio: "ignore" });
  await api(port, token, "POST", "/api/projects", { path: project });
  const rt = orchestrator.ensureProject(project);
  const task = rt.store.create({ projectId: rt.entry.path, title: "V8 正常恢复", requirement: "V8", criteria: [fileCriterion()], steps: [] });
  const t1 = rt.store.get(task.id)!;
  rt.store.forceStatus(t1, "running", "模拟异常退出时的状态"); // recoverCount=0 → 恢复 1 次
  const worker = new FakeWorker(() => ({ writeFiles: { "index.html": "<h1>ok</h1>" } }));
  // 等效重启：全新编排器实例从磁盘恢复（recoverCount=0 → 恢复 1 次，入队队首）
  const { Orchestrator } = await import("../orchestrator");
  const o2 = new Orchestrator();
  const rt2 = o2.addProject(project); // 恢复 + 入队
  const t2 = rt2.store.get(task.id)!;
  assert.equal(t2.recoverCount, 1);
  // addProject 返回后队列泵已启动：可能已入队（queued/running）甚至进入验收（verifying），终态 passed 亦可
  assert.ok(["queued", "running", "verifying", "passed"].includes(t2.status), `恢复任务应入队执行，实际 ${t2.status}`);
  await waitFor(() => rt2.store.get(task.id)!.status === "passed");
  assert.ok(fs.existsSync(path.join(project, "index.html")), "恢复后工人应完成任务");
  assert.ok(fs.existsSync(path.join(project, ".dispatch", "tasks", `${task.id}.json`)), "任务文件落盘");
  void api;
});

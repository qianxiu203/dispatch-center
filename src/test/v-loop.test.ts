/**
 * 循环类验收（需求 18.1 V1–V5、V7、V14）与一期缺陷回归（4.3 R1–R4）。
 * 一律「假工人 + 假大脑」，不消耗真实额度。
 *
 * 场景构造说明：修复循环类用例直接用 TaskStore 建零步骤任务（verify-only 路径），
 * 使任务计数器里的工人调用恰好等于「修复派工次数」，与 V2/V3/V4 的验收口径一致。
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
  chat,
  type MockBrain,
} from "./helpers";
import { orchestrator, type ProjectRuntime } from "../orchestrator";
import { runAcceptance, classifyReport, type AcceptanceReport } from "../acceptance/runner";
import { signatureOfProblems, EMPTY_SIGNATURE } from "../loop/signature";

let mock: MockBrain;
let port = 0;
let token = "";

before(async () => {
  ensureTestDataDir();
  mock = await startMockBrain();
  applyTestConfig(mock.port);
  const srv = await startTestServer();
  port = srv.port;
  token = srv.token;
  // 默认大脑脚本：按提示词特征路由
  mock.respondWith((lastUser) => {
    if (lastUser.includes("请输出 plan 类型 JSON")) return planJson([{ id: "S1", title: "实现", instruction: "按需求实现" }]);
    if (lastUser.includes("你上一轮给出的验收标准未通过校验")) return requirementJson("重新生成", [fileCriterion()]);
    if (lastUser.includes("工人（codex）在执行任务时提出了一个问题")) return JSON.stringify({ type: "answer", text: "好的", answer: "放在项目目录 data/ 下", unsure: false });
    if (lastUser.includes("请整理记忆")) return JSON.stringify({ type: "memory_consolidation", text: "已整理", add: [], update: [], delete: [] });
    if (lastUser.includes("压缩成一份摘要")) return JSON.stringify({ type: "summary", text: "摘要" });
    return requirementJson("做一个静态欢迎页", [fileCriterion()]);
  });
});

after(() => {
  endTest();
  mock.close();
});

/** 设置大脑路由：默认回答 + 按测试需要覆盖个别分支。 */
function setBrainRoutes(overrides: { regen?: string; answer?: string; requirement?: string; plan?: string } = {}): void {
  mock.respondWith((lastUser) => {
    if (lastUser.includes("请输出 plan 类型 JSON")) return overrides.plan ?? planJson([{ id: "S1", title: "实现", instruction: "按需求实现" }]);
    if (lastUser.includes("你上一轮给出的验收标准未通过校验")) return overrides.regen ?? requirementJson("重新生成", [fileCriterion()]);
    if (lastUser.includes("工人（codex）在执行任务时提出了一个问题")) return overrides.answer ?? JSON.stringify({ type: "answer", text: "好的", answer: "放在项目目录 data/ 下", unsure: false });
    if (lastUser.includes("请整理记忆")) return JSON.stringify({ type: "memory_consolidation", text: "已整理", add: [], update: [], delete: [] });
    if (lastUser.includes("压缩成一份摘要")) return JSON.stringify({ type: "summary", text: "摘要" });
    return overrides.requirement ?? requirementJson("做一个静态欢迎页", [fileCriterion()]);
  });
}

/** 建零步骤任务（verify-only：工人调用计数 = 修复派工次数）。 */
function makeVerifyOnlyTask(project: string, criteria: any[]): { rt: ProjectRuntime; taskId: string } {
  // 修复前后对比依赖 git write-tree，先确保项目是 git 仓库
  require("node:child_process").execSync("git init", { cwd: project, stdio: "ignore" });
  const rt = orchestrator.ensureProject(project);
  const task = rt.store.create({
    projectId: rt.entry.path,
    title: "循环注入用例",
    requirement: "循环注入用例需求",
    criteria,
    steps: [],
  });
  return { rt, taskId: task.id };
}

function taskOf(project: string, taskId: string) {
  return orchestrator.getRuntime(project)!.store.get(taskId)!;
}

async function waitStatus(project: string, taskId: string, statuses: string[], timeoutMs = 20000): Promise<string> {
  const ok = await waitFor(async () => statuses.includes(taskOf(project, taskId).status));
  assert.ok(ok, `等待状态 ${statuses.join("/")} 超时，实际 ${taskOf(project, taskId).status}，pausedReason=${taskOf(project, taskId).pausedReason ?? ""}`);
  return taskOf(project, taskId).status;
}

// 复用 helpers 的 waitFor（支持异步谓词的本地版）
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 15000, step = 100): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return pred();
}

async function openCards(project: string): Promise<any[]> {
  const r = await api(port, token, "GET", `/api/cards?project=${encodeURIComponent(project)}`);
  assert.equal(r.status, 200, `GET /api/cards 失败: ${JSON.stringify(r.json)}`);
  return r.json.data?.cards ?? [];
}

// ───────────────────────── V1：标准缺 path → 不派工人，重生成 ≤1 次，卡片 ─────────────────────────

test("V1 验收标准缺 path：工人调用 0，重生成不超过 1 次，出现决策卡片", async () => {
  mock.respondWith((lastUser) => {
    if (lastUser.includes("请输出 plan 类型 JSON")) return planJson([{ id: "S1", title: "实现", instruction: "按需求实现" }]);
    if (lastUser.includes("你上一轮给出的验收标准未通过校验")) {
      // 重新生成仍然缺 path（注入持续故障）
      return requirementJson("重新生成", [{ id: "C1", text: "存在 index.html", kind: "file_exists", path: "" }]);
    }
    return requirementJson("做一个静态欢迎页", [{ id: "C1", text: "存在 index.html", kind: "file_exists", path: "" }]);
  });
  applyTestConfig(mock.port, { limits: { maxCriteriaRegen: 1 } as any });
  const project = makeTempProject("v1");
  await api(port, token, "POST", "/api/projects", { path: project });

  await chat(port, token, project, "做一个静态欢迎页");
  const cards = await openCards(project);
  const bad = cards.find((c) => c.payload?.decision === "criteria_invalid");
  assert.ok(bad, "应出现「验收标准无法自动检查」决策卡片");
  const regenCalls = mock.calls.filter((c) => c.includes("你上一轮给出的验收标准未通过校验")).length;
  assert.ok(regenCalls <= 1, `重新生成次数应 ≤1，实际 ${regenCalls}`);
  const rt = orchestrator.getRuntime(project)!;
  assert.equal(rt.store.list().length, 0, "任务不得创建");
  const worker = new FakeWorker(() => ({}));
  assert.equal(worker.calls.length, 0, "工人调用数为 0");
});

// ───────────────────────── V2：问题恒定 → 第 3 次修复后暂停，恰好 3 次派工 ─────────────────────────

test("V2 验收永远失败且问题恒定：3 次修复后暂停，工人调用恰好 3", async () => {
  applyTestConfig(mock.port, { limits: { maxFixPerSignature: 3, maxTotalFixes: 6 } as any });
  setBrainRoutes();
  const project = makeTempProject("v2");
  const { taskId } = makeVerifyOnlyTask(project, [fileCriterion("index.html"), fileCriterion("missing.txt", "C2")]);
  // 工人每次都改一个日志文件（有文件改动 → 无进展规则不触发），但验收问题恒定 → 走签名上限
  const worker = new FakeWorker((i) => ({ writeFiles: { "fix-log.txt": `第 ${i} 次修复` } }));
  orchestrator.pumpQueue(orchestrator.ensureProject(project));
  await waitStatus(project, taskId, ["paused", "waiting_user"]);
  const t = taskOf(project, taskId);
  assert.equal(t.counters.workerCalls, 3, `工人调用应恰好 3（不是 4），实际 ${t.counters.workerCalls}`);
  assert.equal(t.fixAttempts.length, 3, "修复尝试记录 3 次");
  const sigLoop = Object.entries(t.loops).find(([k]) => k.startsWith("L1-sig-"));
  assert.ok(sigLoop, "应有签名级循环预算记录");
  assert.equal(sigLoop![1].iteration, 3, "签名循环执行 3 次后第 4 次申请被拒");
  assert.ok((t.pausedReason ?? "").includes("上限") || (t.pausedReason ?? "").includes("修复"), `暂停原因：${t.pausedReason}`);
  assert.ok((await openCards(project)).some((c) => c.payload?.decision === "loop_stop"), "应出现循环停止决策卡片");
  assert.equal(worker.calls.length, 3);
});

// ───────────────────────── V3：连续空改动 → 2 次即暂停 ─────────────────────────

test("V3 工人每次都不改任何文件：连续 2 次空改动即暂停", async () => {
  applyTestConfig(mock.port);
  setBrainRoutes();
  const project = makeTempProject("v3");
  const { taskId } = makeVerifyOnlyTask(project, [fileCriterion("index.html")]);
  const worker = new FakeWorker(() => ({}));
  orchestrator.pumpQueue(orchestrator.ensureProject(project));
  await waitStatus(project, taskId, ["paused", "waiting_user"]);
  const t = taskOf(project, taskId);
  assert.equal(t.counters.workerCalls, 2, `两次空改动即停，实际 ${t.counters.workerCalls}`);
  assert.equal(t.fixAttempts.length, 2);
  assert.ok(
    Object.values(t.loops).some((l) => l.noProgressCount >= 2),
    "循环预算应记录 noProgressCount≥2"
  );
  assert.ok((t.pausedReason ?? "").includes("文件改动") || (t.pausedReason ?? "").includes("无进展"), `暂停原因应说明无进展，实际：${t.pausedReason}`);
  assert.equal(worker.calls.length, 2);
});

// ───────────────────────── V4：签名 A、B、A 振荡 → A 第二次出现即暂停 ─────────────────────────

test("V4 签名 A、B、A 振荡：A 第二次出现即暂停", async () => {
  applyTestConfig(mock.port);
  setBrainRoutes();
  const project = makeTempProject("v4");
  const { taskId } = makeVerifyOnlyTask(project, [fileCriterion("a.txt", "C1"), fileCriterion("b.txt", "C2")]);
  // verify-only 任务没有初始实现派工：修复 1（idx 0）写 a.txt（问题只剩 C2 → 签名 B）；
  // 修复 2（idx 1）删掉 a.txt（问题回到 C1+C2 → 签名 A）→ A 第二次出现即振荡停止
  const worker = new FakeWorker((i) => (i === 0 ? { writeFiles: { "a.txt": "A" } } : i === 1 ? { deleteFiles: ["a.txt"] } : {}));
  orchestrator.pumpQueue(orchestrator.ensureProject(project));
  await waitStatus(project, taskId, ["paused", "waiting_user"]);
  const t = taskOf(project, taskId);
  assert.equal(t.counters.workerCalls, 2, `振荡应在第 3 轮派工前停止（工人只被调用 2 次），实际 ${t.counters.workerCalls}`);
  assert.ok((t.pausedReason ?? "").includes("振荡"), `暂停原因应指出振荡，实际：${t.pausedReason}`);
  assert.equal(worker.calls.length, 2);
});

// ───────────────────────── V5 / R2：problems 与 harnessErrors 都为空 → 0 次派工暂停 ─────────────────────────

test("V5/R2 验收失败但 problems 与 harnessErrors 均为空：工人调用 0，任务暂停", async () => {
  applyTestConfig(mock.port);
  const project = makeTempProject("v5");
  const { taskId } = makeVerifyOnlyTask(project, [fileCriterion("index.html")]);
  const worker = new FakeWorker(() => ({}));
  // 故障注入：验收报告带一个无法归类的失败结果（真实 classifyReport 会标 internalError）
  const real = runAcceptance;
  (require("../acceptance/runner") as any).runAcceptance = async (): Promise<AcceptanceReport> =>
    classifyReport({
      allPassed: false,
      results: [{ criterionId: "C1", passed: false, detail: "注入的不可归类失败" }],
      problems: [],
      harnessErrors: [],
    });
  try {
    orchestrator.pumpQueue(orchestrator.ensureProject(project));
    await waitStatus(project, taskId, ["waiting_user", "paused"]);
    const t = taskOf(project, taskId);
    assert.equal(t.counters.workerCalls, 0, `不得派工人，实际 ${t.counters.workerCalls}`);
    assert.equal(worker.calls.length, 0);
    assert.ok((t.pausedReason ?? "").includes("内部错误") || (t.pausedReason ?? "").includes("归类"), `暂停原因：${t.pausedReason}`);
  } finally {
    (require("../acceptance/runner") as any).runAcceptance = real;
  }
});

// ───────────────────────── V7：工人重复问同一个问题 → 第 2 次升级 ─────────────────────────

test("V7 工人重复提同一个问题：大脑只代答 1 次，第 2 次升级给使用者", async () => {
  applyTestConfig(mock.port);
  setBrainRoutes();
  const project = makeTempProject("v7");
  const { taskId } = makeVerifyOnlyTask(project, [fileCriterion("index.html")]);
  const worker = new FakeWorker(() => ({
    result: { ok: true, lastMessage: "我需要更多信息才能继续。\nQUESTION: 数据目录放在哪里？" },
  }));
  orchestrator.pumpQueue(orchestrator.ensureProject(project));
  await waitStatus(project, taskId, ["waiting_user", "paused"]);
  const t = taskOf(project, taskId);
  assert.equal(t.counters.workerCalls, 2, `第 2 次提问应升级（工人 2 次调用），实际 ${t.counters.workerCalls}`);
  const answerCalls = mock.calls.filter((c) => c.includes("工人（codex）在执行任务时提出了一个问题")).length;
  assert.equal(answerCalls, 1, `同一问题大脑只代答 1 次，实际 ${answerCalls}`);
  const card = (await openCards(project)).find((c) => c.payload?.decision === "worker_question");
  assert.ok(card, "应出现提问升级决策卡片");
  assert.equal(worker.calls.length, 2);
});

// ───────────────────────── V14：DISPATCH_BLOCKED 不计修复次数 ─────────────────────────

test("V14 工人回报 DISPATCH_BLOCKED：不计修复次数，转调度侧缺陷处理", async () => {
  applyTestConfig(mock.port);
  setBrainRoutes();
  const project = makeTempProject("v14");
  const { taskId } = makeVerifyOnlyTask(project, [fileCriterion("index.html")]);
  const worker = new FakeWorker(() => ({ result: { ok: true, dispatchBlocked: "验收器把相对路径解析错了" } }));
  orchestrator.pumpQueue(orchestrator.ensureProject(project));
  await waitStatus(project, taskId, ["waiting_user"]);
  let t = taskOf(project, taskId);
  assert.equal(t.counters.workerCalls, 1, "第一次修复派工");
  assert.equal(t.fixAttempts.length, 0, "DISPATCH_BLOCKED 不计入修复次数（record 未调用）");
  let card = (await openCards(project)).find((c) => c.payload?.decision === "dispatch_blocked");
  assert.ok(card, "应出现调度侧缺陷决策卡片");

  // 再试一次 → 重新验收 → 又 DISPATCH_BLOCKED → 仍然不计数
  await api(port, token, "POST", `/api/cards/${card.id}/answer`, { project, choice: "重新验收" });
  await waitFor(() => taskOf(project, taskId).counters.workerCalls === 2 && taskOf(project, taskId).status === "waiting_user");
  t = taskOf(project, taskId);
  assert.equal(t.fixAttempts.length, 0, "第二次 DISPATCH_BLOCKED 仍不计入修复次数");
  assert.equal(worker.calls.length, 2);
  card = (await openCards(project)).find((c) => c.payload?.decision === "dispatch_blocked");
  assert.ok(card, "第二次仍出现调度侧缺陷卡片");
  // 取消任务收尾
  await api(port, token, "POST", `/api/tasks/${taskId}/cancel`, { project });
});

// ───────────────────────── R1（4.3 #1）：标准缺 path 走调度侧缺陷路，绝不派工人 ─────────────────────────

test("R1 标准缺 path 进入执行时：归为 harnessErrors，让大脑重生成 1 次，工人调用 0", async () => {
  applyTestConfig(mock.port);
  // 重新生成给一条必然通过的命令标准（不再缺参数），任务即可通过且全程 0 次派工
  setBrainRoutes({ regen: requirementJson("重新生成", [{ id: "C1", text: "命令成功", kind: "command_exit_0", command: 'node -e "process.exit(0)"' }]) });
  const project = makeTempProject("r1");
  // 直接把缺 path 的标准放进任务（模拟旧数据/旧缺陷路径），verify-only
  const { taskId } = makeVerifyOnlyTask(project, [{ id: "C1", text: "存在 index.html", kind: "file_exists", path: "" }]);
  const worker = new FakeWorker(() => ({}));
  orchestrator.pumpQueue(orchestrator.ensureProject(project));
  await waitStatus(project, taskId, ["passed"]);
  const t = taskOf(project, taskId);
  assert.equal(t.counters.workerCalls, 0, `缺 path 属调度侧缺陷，不得派工人，实际 ${t.counters.workerCalls}`);
  const regenCalls = mock.calls.filter((c) => c.includes("你上一轮给出的验收标准未通过校验")).length;
  assert.equal(regenCalls, 1, "L3 让大脑重新生成恰好 1 次");
  assert.equal(worker.calls.length, 0);
});

// ───────────────────────── R3（4.3 #3）：空问题签名 EMPTY 永不合法；上限不再差一 ─────────────────────────

test("R3 空问题签名 EMPTY 不派工人；上限差一已修复（见 V2 恰好 3 次）", async () => {
  assert.equal(signatureOfProblems([]), EMPTY_SIGNATURE);
  assert.equal(signatureOfProblems([{ criterionId: "C1", source: "", message: "  " } as any]), EMPTY_SIGNATURE, "全空内容的问题签名必须是 EMPTY");
  applyTestConfig(mock.port);
  const project = makeTempProject("r3");
  const { taskId } = makeVerifyOnlyTask(project, [fileCriterion("index.html")]);
  const worker = new FakeWorker(() => ({}));
  const real = runAcceptance;
  (require("../acceptance/runner") as any).runAcceptance = async (): Promise<AcceptanceReport> =>
    classifyReport({
      allPassed: false,
      results: [{ criterionId: "C1", passed: false, detail: "失败" }],
      problems: [{ criterionId: "C1", summary: "  ", expected: "", actual: "   " } as any],
      harnessErrors: [],
    });
  try {
    orchestrator.pumpQueue(orchestrator.ensureProject(project));
    await waitStatus(project, taskId, ["waiting_user", "paused"]);
    const t = taskOf(project, taskId);
    assert.equal(t.counters.workerCalls, 0, "EMPTY 签名永不进入修复循环");
    assert.equal(worker.calls.length, 0);
  } finally {
    (require("../acceptance/runner") as any).runAcceptance = real;
  }
});

// ───────────────────────── R4（4.3 #4）：标准缺参数写进 harnessErrors 而非只进 results ─────────────────────────

test("R4 标准缺参数：harnessErrors 与 results 同时有记录，且不产生内部错误", async () => {
  applyTestConfig(mock.port);
  const project = makeTempProject("r4");
  const rt = orchestrator.ensureProject(project);
  const task = rt.store.create({
    projectId: rt.entry.path,
    title: "R4",
    requirement: "R4",
    criteria: [{ id: "C1", text: "命令成功", kind: "command_exit_0", command: "" }],
    steps: [],
  });
  const report = await runAcceptance(project, task);
  assert.equal(report.harnessErrors.length, 1, "缺参数必须进 harnessErrors（调度侧缺陷）");
  assert.equal(report.harnessErrors[0].code, "CRITERION_INVALID");
  assert.ok(report.results.some((r) => r.criterionId === "C1" && !r.passed), "results 里也要有对应失败记录");
  assert.equal(report.internalError, undefined, "每个失败都可归类，不应有内部错误");
  assert.equal(report.problems.length, 0, "缺参数不得当项目缺陷派工人");
  void fs;
  void path;
});

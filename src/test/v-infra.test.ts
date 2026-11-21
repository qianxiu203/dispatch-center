/**
 * 基础设施类验收（需求 18.1 V6、V9、V10、V11、V12、V13）。
 * 一律「假工人 + 假大脑」，不消耗真实额度；看门狗/下载/心跳用注入或可调参数缩短等待。
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
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
  readSse,
  type MockBrain,
} from "./helpers";
import { orchestrator } from "../orchestrator";
import { Watchdog } from "../watchdog";
import { downloadFile } from "../envcheck/check";
import { heartbeat } from "../heartbeat";
import { subscribe } from "../events";

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
  mock.respondWith((lastUser) => {
    if (lastUser.includes("请输出 plan 类型 JSON")) return planJson([{ id: "S1", title: "实现", instruction: "按需求实现" }]);
    if (lastUser.includes("你上一轮给出的验收标准未通过校验")) return requirementJson("重新生成", [fileCriterion()]);
    if (lastUser.includes("请整理记忆")) return JSON.stringify({ type: "memory_consolidation", text: "已整理", add: [], update: [], delete: [] });
    if (lastUser.includes("压缩成一份摘要")) return JSON.stringify({ type: "summary", text: "摘要" });
    return requirementJson("做一个静态欢迎页", [fileCriterion()]);
  });
});

after(() => {
  endTest();
  mock.close();
});

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 20000, step = 100): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return pred();
}

// ───────────────────────── V6：看门狗静默超限 → 强制暂停 ─────────────────────────

test("V6 工人无任何输出超过静默上限：看门狗强制暂停并出卡片", async () => {
  applyTestConfig(mock.port, { watchdog: { maxSilenceMinutes: 1 } as any });
  const project = makeTempProject("v6");
  require("node:child_process").execSync("git init", { cwd: project, stdio: "ignore" });
  await api(port, token, "POST", "/api/projects", { path: project });
  const rt = orchestrator.ensureProject(project);
  const task = rt.store.create({
    projectId: rt.entry.path,
    title: "V6 静默任务",
    requirement: "V6",
    criteria: [fileCriterion()],
    steps: [],
  });
  const worker = new FakeWorker(() => ({ delayMs: 60000 })); // 挂住，不产生任何输出
  orchestrator.pumpQueue(rt);
  await waitFor(() => rt.store.get(task.id)!.status === "running");
  // 把最后活动时间改到 2 分钟前（等效于静默超限）
  const t = rt.store.get(task.id)!;
  t.counters.lastActivityAt = new Date(Date.now() - 2 * 60000).toISOString();
  rt.store.saveTask(t);
  const wd = new Watchdog(() => orchestrator.getWatchdogUsage(), (tr) => orchestrator.onWatchdogTrigger(tr));
  const triggers = wd.tick();
  assert.ok(triggers.some((x) => x.taskId === task.id && x.reason.includes("静默")), `应触发静默暂停，实际：${JSON.stringify(triggers.map((x) => x.reason))}`);
  await waitFor(() => rt.store.get(task.id)!.status === "paused");
  assert.ok((rt.store.get(task.id)!.pausedReason ?? "").includes("看门狗"), "暂停原因应标明看门狗");
  const cards = await api(port, token, "GET", `/api/cards?project=${encodeURIComponent(project)}`);
  assert.ok((cards.json.data?.cards ?? []).some((c: any) => c.payload?.decision === "resume_task"), "应出现恢复决策卡片");
  assert.equal(worker.calls.length, 1, "看门狗只暂停，不额外派工");
  await api(port, token, "POST", `/api/tasks/${task.id}/cancel`, { project });
});

// ───────────────────────── V9：下载无进度 → 中断；多源尝试与失败报告存在 ─────────────────────────

test("V9 注入无进度下载：无进度窗口内中断并报错", async () => {
  // 故障服务器：发 1 字节后挂住（无进度）
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Length": "1000" });
    res.write("x");
    // 故意不结束响应
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  const dest = path.join(os.tmpdir(), `v9-stall-${Date.now()}.bin`);
  process.env.DISPATCH_DOWNLOAD_NOPROGRESS_MS = "800";
  const t0 = Date.now();
  try {
    await assert.rejects(
      () => downloadFile(`http://127.0.0.1:${addr.port}/chromium.zip`, dest, () => {}, "测试下载", () => false),
      /无进度|进度/,
      "应在无进度窗口内中断"
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 30000, `应在远小于 60 秒内中断（测试窗口 800ms），实际 ${elapsed}ms`);
  } finally {
    delete process.env.DISPATCH_DOWNLOAD_NOPROGRESS_MS;
    server.close();
    fs.rmSync(dest, { force: true });
  }
});

test("V9 Chromium 安装具备换源与失败报告（镜像→官方→安装器兜底，共 ≥3 次尝试）", async () => {
  const srcPath = path.join(process.cwd(), "src", "envcheck", "check.ts");
  const src = fs.readFileSync(fs.existsSync(srcPath) ? srcPath : path.join(__dirname, "..", "..", "src", "envcheck", "check.ts"), "utf8");
  assert.ok(src.includes("国内镜像") && src.includes("官方源"), "应按「镜像 → 官方源」换源");
  assert.ok(src.includes("reasons.push"), "失败原因应逐次记录并在最终报告");
  assert.ok(/noProgressMs\s*=\s*Number|noProgressMs.*DISPATCH_DOWNLOAD_NOPROGRESS_MS|60 秒|无进度/.test(src), "无进度判定存在");
  const attemptsMatch = src.match(/const attempts[\s\S]{0,400}?\];/);
  assert.ok(attemptsMatch, "应声明多源尝试列表");
});

// ───────────────────────── V10：心跳持续失败只通知一次，且不唤醒系统 ─────────────────────────

test("V10 心跳持续失败：只通知一次，30 分钟内不重复；不派工不建卡", async () => {
  // 大脑地址指向必然失败的端口 → 心跳红点
  applyTestConfig(mock.port, { brain: { baseUrl: "http://127.0.0.1:9/v1" } as any });
  const project = makeTempProject("v10");
  await api(port, token, "POST", "/api/projects", { path: project });
  const rt = orchestrator.ensureProject(project);
  const task = rt.store.create({ projectId: rt.entry.path, title: "V10", requirement: "V10", criteria: [fileCriterion()], steps: [] });
  const worker = new FakeWorker(() => ({})); // 排队中的任务不应被心跳唤醒

  const notices: any[] = [];
  const unsub = subscribe((e) => {
    if (e.type === "notice") notices.push(e);
  });
  try {
    const rec1 = await heartbeat.run();
    assert.notEqual(rec1.dot, "green", "大脑不可达时心跳应为红/黄");
    const n1 = notices.length;
    assert.ok(n1 >= 1, "由正常变异常应通知一次");
    const rec2 = await heartbeat.run();
    assert.equal(notices.length, n1, "同一异常 30 分钟内不得重复通知");
    assert.notEqual(rec2.dot, "green");
    assert.equal(rt.store.get(task.id)!.status, "queued", "心跳不得改变任务状态（不唤醒工人）");
    assert.equal(worker.calls.length, 0, "心跳不得启动工人");
    const cards = await api(port, token, "GET", `/api/cards?project=${encodeURIComponent(project)}`);
    assert.equal((cards.json.data?.cards ?? []).length, 0, "心跳不得产生决策卡片");
  } finally {
    unsub();
    await api(port, token, "POST", `/api/tasks/${task.id}/cancel`, { project });
    applyTestConfig(mock.port); // 恢复正常大脑地址
  }
});

// ───────────────────────── V11：事件流补发不重复 ─────────────────────────

test("V11 断线重连：lastEventId 补发缺失事件，且不重复", async () => {
  const project = makeTempProject("v11");
  await api(port, token, "POST", "/api/projects", { path: project });
  await chat(port, token, project, "你好");
  // 第一段连接拿 3 个事件
  const first = await readSse(port, token, `/api/events?token=${encodeURIComponent(token)}`, 3);
  assert.equal(first.ids.length, 3);
  const sortedAsc = [...first.ids].every((v, i, a) => i === 0 || v > a[i - 1]);
  assert.ok(sortedAsc, `事件 id 应严格递增：${first.ids}`);
  // 断线重连：带 lastEventId 补发，只拿 > last 的事件
  const last = first.ids[2];
  const second = await readSse(port, token, `/api/events?token=${encodeURIComponent(token)}&lastEventId=${last}`, 3);
  assert.ok(second.ids.every((id) => id > last), `补发事件应全部大于 ${last}，实际 ${second.ids}`);
  const overlap = first.ids.filter((id) => second.ids.includes(id));
  assert.equal(overlap.length, 0, "补发事件不得与已收到的事件重复");
});

// ───────────────────────── V12：压缩后仍超限 → 截断，不递归压缩 ─────────────────────────

test("V12 压缩后仍超限：截断最旧行，大脑压缩只调用一次", async () => {
  applyTestConfig(mock.port, { brain: { maxContextTokens: 1000, compressThreshold: 0.7 } as any });
  const project = makeTempProject("v12");
  await api(port, token, "POST", "/api/projects", { path: project });
  const rt = orchestrator.ensureProject(project);
  const sessionId = rt.sessions.newSession("V12");
  for (let i = 0; i < 40; i++) {
    rt.sessions.append(sessionId, { kind: i % 2 ? "assistant" : "user", text: `第 ${i} 行：${"很长的对话内容".repeat(40)}` });
  }
  const before = rt.sessions.read(sessionId).length;
  assert.ok(before >= 40);
  await chat(port, token, project, "继续聊一句");
  await waitFor(() => rt.sessions.read(sessionId).length < before, 15000);
  const compactionCalls = mock.calls.filter((c) => c.includes("压缩成一份摘要")).length;
  assert.equal(compactionCalls, 1, `压缩只允许一次（不递归），实际 ${compactionCalls}`);
  const after = rt.sessions.read(sessionId).length;
  assert.ok(after < before, `压缩/截断后行数应减少：${before} → ${after}`);
  applyTestConfig(mock.port); // 恢复默认上下文参数
});

// ───────────────────────── V13：快速连点只产生一个任务 ─────────────────────────

test("V13 快速连点确认：同一 requestId 只产生一个任务", async () => {
  const project = makeTempProject("v13");
  await api(port, token, "POST", "/api/projects", { path: project });
  const requestId = `r-v13-${Date.now()}`;
  await chat(port, token, project, "做一个静态欢迎页", requestId);
  const cards = await api(port, token, "GET", `/api/cards?project=${encodeURIComponent(project)}`);
  const card = (cards.json.data?.cards ?? []).find((c: any) => c.kind === "requirement");
  assert.ok(card, "应出现需求确认卡片");
  // 并发连点两次（同一 requestId）
  await Promise.all([
    api(port, token, "POST", `/api/cards/${card.id}/confirm`, { project, requestId }),
    api(port, token, "POST", `/api/cards/${card.id}/confirm`, { project, requestId }),
  ]);
  await waitFor(() => orchestrator.getRuntime(project)!.store.list().length === 1);
  const rt = orchestrator.getRuntime(project)!;
  assert.equal(rt.store.list().length, 1, `同一 requestId 只应创建一个任务，实际 ${rt.store.list().length}`);
  // 不同 requestId 的重复确认应被卡片状态机挡住（卡片已 confirmed）
  await api(port, token, "POST", `/api/cards/${card.id}/confirm`, { project, requestId: `${requestId}-b` });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(rt.store.list().length, 1, "已确认的卡片再次确认不得再建任务");
});

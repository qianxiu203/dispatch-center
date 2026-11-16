/**
 * A2 验收：聊天回复为流式输出（检查响应分块到达），
 * 且前端拿到的是 delta.content 提取后的文本（不混入原始 SSE 协议文本）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { makeTempProject, startMockBrain, startTestServer, applyTestConfig } from "./helpers";
import { setConfigForTest } from "../config";
import { closeAllServers } from "../server";

describe("A2 聊天流式输出", () => {
  // 60 秒兜底：就算流式卡死也让测试失败退出，而不是永远挂着
  test("SSE 增量分块到达且只含提取后的文本", { timeout: 60000 }, async () => {
    const replyText =
      "好的，我已经理解你的需求：做一个简洁的静态欢迎页，包含标题和一段欢迎语，请查看下方卡片并确认，确认后我会安排工人开始实现。";
    const requirementJson = JSON.stringify({
      type: "requirement",
      text: replyText,
      requirement: "做一个静态欢迎页",
      criteria: [{ id: "C1", text: "存在 index.html", kind: "file_exists", path: "index.html" }],
    });
    // 把 JSON 拆成 10 字符的小片段、每片段间隔 60ms，模拟真实流式：
    // text 值很长，会跨越多个分片，期间应产生多次增量推送
    const pieces: (string | { text: string; delayMs: number })[] = [];
    for (let i = 0; i < requirementJson.length; i += 10) {
      pieces.push({ text: requirementJson.slice(i, i + 10), delayMs: 60 });
    }
    const mock = await startMockBrain({ chunks: pieces });
    applyTestConfig(mock.port);
    setConfigForTest({ port: 3301 });
    const port = await startTestServer();

    const project = makeTempProject("a2");
    await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: project }),
    });

    const t0 = Date.now();
    // 30 秒读取超时：若服务端迟迟不结束响应，中断读取让断言失败而不是挂死
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "做一个欢迎页" }),
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/event-stream"), "响应应为 SSE");

    // 逐块读取，记录每块的到达时间与内容
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const arrivals: { t: number; len: number }[] = [];
    let textReceived = "";
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let evt: any;
        try {
          evt = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (evt.type === "chat-delta" && typeof evt.text === "string") {
          arrivals.push({ t: Date.now() - t0, len: evt.text.length });
          textReceived += evt.text;
        }
      }
    }

    // 1) 分块到达：多于 3 个增量块，且到达时间递增（流式而非一次性）
    try {
      assert.ok(arrivals.length > 3, `应有多个分块到达，实际 ${arrivals.length}`);
      for (let i = 1; i < arrivals.length; i++) {
        assert.ok(arrivals[i].t >= arrivals[i - 1].t, "到达时间应单调不减");
      }
      assert.ok(arrivals[arrivals.length - 1].t - arrivals[0].t > 100, "分块应分布在不同时刻而非同时到达");

      // 2) 内容正确：拼起来等于大脑 text 字段的值
      assert.equal(textReceived, replyText);
      // 3) 不含原始协议文本：没有 SSE 帧、没有上游 JSON 骨架
      assert.ok(!textReceived.includes("data:"), "不得包含原始 SSE 协议文本");
      assert.ok(!textReceived.includes("chat.completion.chunk"), "不得包含上游协议对象");
      assert.ok(!textReceived.includes('"type":"requirement"'), "不得把协议 JSON 原样透出");
    } finally {
      // 必须关闭被测服务与 mock：监听句柄残留会让测试进程永不退出，整个测试套件被拖死
      closeAllServers();
      mock.close();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

/**
 * A9 验收：日志与仓库中不含任何 API Key。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setConfigForTest } from "../config";
import { info, warn, error as logError } from "../logger";
import { appRoot, dataDir } from "../util/paths";

const SENTINEL = "sk-TESTKEY-a9x9x9x9x9x9x9x9x";

describe("A9 密钥不入日志与仓库", () => {
  test("日志中的密钥一律脱敏", () => {
    setConfigForTest({
      brain: { baseUrl: "http://mock", apiKey: SENTINEL, model: "m" },
      worker: { kind: "codex", executablePath: "", baseUrl: "", model: "", apiKey: "" },
    });
    const secret = "Bearer " + SENTINEL;
    info("test", `请求已发送，鉴权头为 ${secret}`);
    warn("test", `配置项 apiKey=${SENTINEL} 校验通过`);
    logError("test", `失败请求携带 sk-abc123XYZsecret456 形式的假 key`);

    // 读取今天的日志文件，断言两个密钥值都不存在
    const logsDir = path.join(dataDir(), "logs");
    const today = new Date();
    const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    const logFile = path.join(logsDir, `dispatch-${stamp}.log`);
    assert.ok(fs.existsSync(logFile), "日志文件应存在");
    const content = fs.readFileSync(logFile, "utf8");
    assert.ok(!content.includes(SENTINEL), "日志不得包含真实密钥值");
    assert.ok(content.includes("***REDACTED***"), "密钥应被脱敏标记替换");
    assert.ok(!content.includes("sk-abc123XYZsecret456"), "兜底正则应拦截 sk- 形式密钥");
  });

  test("仓库跟踪的文件中不含密钥（以哨兵值与常见前缀检查）", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: appRoot() })
      .toString()
      .split("\n")
      .filter(Boolean);
    assert.ok(tracked.includes(".gitignore"), "git 已初始化且跟踪文件");
    assert.ok(!tracked.includes("config.json"), "config.json 不应被跟踪");
    for (const f of tracked) {
      // tools/ 是便携安装的第三方产物（含二进制），不属于密钥扫描对象
      if (f === "tools" || f.startsWith("tools/")) continue;
      // 本文件自身是夹具：哨兵常量就定义在这里，跳过自扫描
      if (f.startsWith("src/test/a9-keys.test.")) continue;
      const abs = path.join(appRoot(), f);
      if (!fs.existsSync(abs)) continue;
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
      const text = fs.readFileSync(abs, "utf8");
      // 二进制文件（含 NUL 字节）的随机字节会撞上密钥形态的正则，跳过
      if (text.includes("\u0000")) continue;
      assert.ok(!text.includes(SENTINEL), `${f} 不得包含测试哨兵密钥`);
      assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(text), `${f} 不得包含真实形态的密钥`);
    }
  });
});

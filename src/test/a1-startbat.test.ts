/**
 * A1 / A10 验收：在 Windows 上双击 start.bat 即可启动并自动打开界面。
 * 云端 Linux 上无法验证「双击」与浏览器拉起，本用例在非 Windows 环境标记跳过；
 * Windows CI（windows-latest）上以 DISPATCH_NO_BROWSER=1 实跑 start.bat 验证服务可用。
 * A10（全部验收在 Windows 通过）由 GitHub Actions 的 windows-latest 任务承担。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { appRoot } from "../util/paths";

describe("A1/A10 start.bat 启动（仅 Windows）", () => {
  test("start.bat 存在且包含关键步骤", () => {
    const bat = path.join(appRoot(), "start.bat");
    assert.ok(fs.existsSync(bat), "start.bat 应存在");
    const content = fs.readFileSync(bat, "utf8");
    assert.ok(content.includes("npm install"), "应包含依赖安装");
    assert.ok(content.includes("npm run build"), "应包含构建");
    assert.ok(content.includes("node dist\\main.js"), "应启动服务");
    assert.ok(content.includes("DISPATCH_NO_BROWSER"), "应支持跳过浏览器（CI/测试）");
  });

  if (process.platform === "win32") {
    test(
      "Windows 上运行 start.bat 后服务可用（模拟双击，跳过浏览器打开）",
      { timeout: 180000 },
      async () => {
      const child = spawn("cmd.exe", ["/c", "start.bat"], {
        cwd: appRoot(),
        env: { ...process.env, DISPATCH_NO_BROWSER: "1" },
        detached: true,
        stdio: "ignore",
      });
      // 轮询健康检查
      let ok = false;
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const res = await fetch("http://127.0.0.1:3210/api/health");
          if (res.ok) {
            ok = true;
            break;
          }
        } catch {
          /* 未就绪 */
        }
      }
      assert.ok(ok, "start.bat 启动后健康检查应通过");
      const rt = JSON.parse(fs.readFileSync(path.join(appRoot(), "data", "runtime.json"), "utf8"));
      assert.ok(rt.port, "应写入 runtime.json 供浏览器打开");
      try {
        process.kill(rt.pid);
      } catch {
        /* 进程可能已退出 */
      }
      child.kill();
      },
    );
  } else {
    test.skip("Windows 上运行 start.bat 后服务可用（需在 Windows 上验证；由 GitHub Actions windows-latest 承担）", () => {});
  }
});

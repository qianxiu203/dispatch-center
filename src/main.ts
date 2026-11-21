/**
 * 调度中心入口：加载配置 → 恢复项目（M8 重启恢复）→ 启动本地服务（仅监听 127.0.0.1）。
 * 随服务启动：心跳（L8）与看门狗（M6）；浏览器打开由 start.sh 负责。
 */
import { bootServer, accessToken } from "./server";
import { Watchdog } from "./watchdog";
import { heartbeat } from "./heartbeat";
import { orchestrator } from "./orchestrator";
import { ensureGlobalDirs } from "./logger";
import { error as logError, info } from "./logger";

async function main(): Promise<void> {
  ensureGlobalDirs();
  const port = await bootServer();
  // 看门狗（M6）：每 30 秒检查运行中任务的总时长/工人调用/静默/大脑调用，触发即暂停
  const watchdog = new Watchdog(
    () => orchestrator.getWatchdogUsage(),
    (trigger) => orchestrator.onWatchdogTrigger(trigger)
  );
  watchdog.start();
  // 心跳（L8）：固定间隔体检，只记录与通知，绝不重启工人或唤醒大脑
  heartbeat.start();
  info("main", `调度中心 v2 已就绪: http://127.0.0.1:${port}/?token=${accessToken()}`);
}

main().catch((e) => {
  logError("main", `启动失败: ${e.message}`);
  console.error(`启动失败: ${e.message}`);
  process.exit(1);
});

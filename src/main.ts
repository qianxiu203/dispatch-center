/**
 * 调度中心入口：加载配置 → 启动本地服务（仅监听 127.0.0.1）。
 * 浏览器打开由 start.bat / start.sh 负责；设置 DISPATCH_NO_BROWSER=1 可跳过（CI/测试用）。
 */
import { bootServer } from "./server";
import { error as logError } from "./logger";

bootServer().catch((e) => {
  logError("main", `启动失败: ${e.message}`);
  console.error(`启动失败: ${e.message}`);
  process.exit(1);
});

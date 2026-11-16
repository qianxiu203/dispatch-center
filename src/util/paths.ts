import * as path from "node:path";
import * as os from "node:os";

/** 调度中心程序自身所在目录（不是项目目录）。 */
export function appRoot(): string {
  // 编译后本文件位于 dist/util/，程序目录需上跳两级（dist/util → dist → 程序根）
  return path.resolve(__dirname, "..", "..");
}

/** 调度中心运行时数据目录（日志、截图等，gitignore 排除）。 */
let dataDirOverride: string | null = null;

/** 测试专用：把运行时数据目录重定向到临时目录，避免测试污染真实的 data/（并发测试还会互相覆盖 projects.json）。 */
export function setDataDirForTest(dir: string): void {
  dataDirOverride = dir;
}

export function dataDir(): string {
  return dataDirOverride ?? path.join(appRoot(), "data");
}

/** 便携工具安装根目录：安装到调度中心自己的目录，不污染系统环境（需求 6.7）。 */
export function toolsDir(): string {
  return path.join(appRoot(), "tools");
}

/** 项目目录下的状态目录：任务状态文件落在这里（需求 6.2）。 */
export function projectStateDir(projectDir: string): string {
  return path.join(projectDir, ".dispatch");
}

/** 项目状态文件路径。 */
export function projectStateFile(projectDir: string): string {
  return path.join(projectStateDir(projectDir), "state.json");
}

/** 跨平台安全地拼接项目内相对路径，禁止逃出项目目录（需求 4.3）。 */
export function safeJoin(projectDir: string, rel: string): string {
  const abs = path.resolve(projectDir, rel);
  const normProject = path.resolve(projectDir);
  if (abs !== normProject && !abs.startsWith(normProject + path.sep)) {
    throw new Error(`路径越出项目目录: ${rel}`);
  }
  return abs;
}

/** 用户主目录（跨平台）。 */
export function userHome(): string {
  return os.homedir();
}

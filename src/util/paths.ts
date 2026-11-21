import * as path from "node:path";
import * as os from "node:os";

/** 调度中心程序自身所在目录（不是项目目录）。 */
export function appRoot(): string {
  // 编译后本文件位于 dist/util/，程序目录需上跳两级（dist/util → dist → 程序根）
  return path.resolve(__dirname, "..", "..");
}

/** 调度中心运行时数据目录（日志、截图等，gitignore 排除）。 */
let dataDirOverride: string | null = null;

/** 测试专用：把运行时数据目录重定向到临时目录，避免测试污染真实的 data/。 */
export function setDataDirForTest(dir: string): void {
  dataDirOverride = dir;
}

export function dataDir(): string {
  return dataDirOverride ?? path.join(appRoot(), "data");
}

/** 便携工具安装根目录：安装到调度中心自己的目录，不污染系统环境（需求 6.7/11.4）。 */
export function toolsDir(): string {
  return path.join(appRoot(), "tools");
}

/** 全局调度中心目录（需求 5.1：用户目录下 .dispatch-center/）。测试可重定向。 */
let globalDirOverride: string | null = null;

export function setGlobalDirForTest(dir: string): void {
  globalDirOverride = dir;
}

export function globalDir(): string {
  return globalDirOverride ?? path.join(os.homedir(), ".dispatch-center");
}

/** 全局记忆文件（需求 9.4：使用者偏好，跨项目共享）。 */
export function globalMemoryFile(): string {
  return path.join(globalDir(), "memory", "user.md");
}

/** 项目目录下的状态目录：任务、会话、记忆、报告、回收站（需求 5.1）。 */
export function projectDispatchDir(projectDir: string): string {
  return path.join(projectDir, ".dispatch");
}

export function projectTasksDir(projectDir: string): string {
  return path.join(projectDispatchDir(projectDir), "tasks");
}

export function projectSessionsDir(projectDir: string): string {
  return path.join(projectDispatchDir(projectDir), "sessions");
}

export function projectMemoryFile(projectDir: string): string {
  return path.join(projectDispatchDir(projectDir), "memory", "project.md");
}

export function projectReportsDir(projectDir: string): string {
  return path.join(projectDispatchDir(projectDir), "reports");
}

/** 软删除回收站（需求 6.4：移除的任务文件移入 trash 保留 7 天）。 */
export function projectTrashDir(projectDir: string): string {
  return path.join(projectDispatchDir(projectDir), "trash");
}

/** 跨平台安全地拼接项目内相对路径，禁止逃出项目目录（需求 4.3/5.3）；越界时抛错。 */
export function safeJoin(projectDir: string, rel: string): string {
  const abs = path.resolve(projectDir, rel);
  const normProject = path.resolve(projectDir);
  if (abs !== normProject && !abs.startsWith(normProject + path.sep)) {
    throw new Error(`路径越出项目目录: ${rel}`);
  }
  return abs;
}

/** 项目内相对路径校验（需求 5.3：file_exists 的 path 必须是项目内相对路径，不得含 .. 或绝对路径）。 */
export function isSafeProjectRelPath(rel: string): boolean {
  if (!rel) return false;
  if (path.isAbsolute(rel)) return false;
  if (rel.includes("..")) return false;
  return true;
}

/** 用户主目录（跨平台）。 */
export function userHome(): string {
  return os.homedir();
}

/** 项目唯一 id：路径的稳定哈希（项目路径即身份，改名视为新项目）。 */
export function projectIdOf(projectDir: string): string {
  return cryptoHash(path.resolve(projectDir)).slice(0, 12);
}

import * as crypto from "node:crypto";
export function cryptoHash(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

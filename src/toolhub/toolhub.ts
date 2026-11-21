/**
 * ToolHub：工人侧 MCP 服务器与 skills 配置管理（需求 12）。
 *
 * 配置位置与格式依据官方文档与 CLI 实测（2026-11-20，codex-cli 0.169.0）：
 * - MCP 服务器配置在 $CODEX_HOME/config.toml（默认 ~/.codex/config.toml）的 [mcp_servers.<id>] 段；
 *   官方 CLI 提供 `codex mcp add <NAME> (--url <URL> | -- <COMMAND>...)`、`--env KEY=VALUE`、
 *   `codex mcp list / get / remove`（本机 --help 实测）。
 * - 启用/停用：官方配置参考 mcp_servers.<id>.enabled（boolean，"Disable an MCP server without
 *   removing its configuration"）→ 修改 config.toml 中该段的 enabled 键实现启停，无需重启调度中心；
 *   对正在运行的任务不生效，下一个任务生效（需求 12.4）。
 * - skills 的用户级目录：官方文档（developers.openai.com/codex/skills）USER 作用域为
 *   $HOME/.agents/skills → 导入目标即该目录。
 * - 修改 config.toml 前备份、写入后用 `codex mcp get <name>` 验证、失败自动还原（需求 12.1）。
 * - 测试连通：启动服务器进程并发 MCP 标准握手（initialize → initialized → tools/list，
 *   newline-delimited JSON-RPC），超时 15 秒，列出工具。
 */
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getConfig } from "../config";
import { info, warn } from "../logger";

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function configTomlFile(): string {
  return path.join(codexHome(), "config.toml");
}

function skillsDir(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

function runCodex(args: string[], timeout = 30000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const cmd = isWin ? joinShellCommand("codex", args) : "codex";
    const argv = isWin ? [] : args;
    execFile(cmd, argv, { timeout, windowsHide: true, shell: isWin }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

function joinShellCommand(exe: string, args: string[]): string {
  const q = (a: string) => (/\s/.test(a) && !/^".*"$/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return [exe, ...args].map(q).join(" ");
}

export interface McpServerInfo {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
}

/** 解析 config.toml 中 [mcp_servers.<name>] 段（简单键值解析，覆盖 command/args/env/enabled/url）。 */
export function parseMcpServersFromToml(content: string): McpServerInfo[] {
  const servers: McpServerInfo[] = [];
  const lines = content.split(/\r?\n/);
  let current: McpServerInfo | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const sec = line.match(/^\[mcp_servers\.([^\."\]]+)\]$/);
    if (sec) {
      if (current) servers.push(current);
      current = { name: sec[1], enabled: true };
      continue;
    }
    if (current && line && !line.startsWith("#")) {
      const kv = line.match(/^([A-Za-z_]+)\s*=\s*(.+)$/);
      if (!kv) continue;
      const key = kv[1];
      let val: any = kv[2].trim();
      try {
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        else if (val === "true") val = true;
        else if (val === "false") val = false;
        else if (val.startsWith("[")) {
          const items = val.slice(1, -1).split(",").map((s: string) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
          val = items;
        } else if (val.startsWith("{")) {
          const obj: Record<string, string> = {};
          const inner = val.slice(1, -1);
          for (const pair of inner.split(",")) {
            const m = pair.match(/"?([^"=]+)"?\s*=\s*"?([^"]*)"?/);
            if (m) obj[m[1].trim()] = m[2].trim();
          }
          val = obj;
        }
      } catch {
        /* 保留原始字符串 */
      }
      if (key === "enabled") current.enabled = val !== false;
      else if (key === "command") current.command = String(val);
      else if (key === "args") current.args = Array.isArray(val) ? val.map(String) : [];
      else if (key === "env") current.env = val as Record<string, string>;
      else if (key === "url") current.url = String(val);
    }
  }
  if (current) servers.push(current);
  return servers;
}

/** 列出工人侧 MCP 服务器（优先官方 CLI；CLI 失败时读 config.toml 兜底）。 */
export async function listMcpServers(): Promise<{ servers: McpServerInfo[]; via: string }> {
  const r = await runCodex(["mcp", "list"], 20000);
  let fileServers: McpServerInfo[] = [];
  try {
    fileServers = parseMcpServersFromToml(fs.readFileSync(configTomlFile(), "utf8"));
  } catch {
    /* 没有 config.toml */
  }
  if (r.code !== 0) return { servers: fileServers, via: "config.toml（codex mcp list 不可用）" };
  // CLI 输出供人读，字段有限；以 config.toml 为准取结构化信息，CLI 结果仅校验可用性
  return { servers: fileServers, via: "config.toml + codex mcp list" };
}

/** 添加 MCP 服务器（官方 CLI `codex mcp add`；依据见文件头）。 */
export async function addMcpServer(params: {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}): Promise<{ ok: boolean; detail: string }> {
  if (!params.name || /[^\w.-]/.test(params.name)) return { ok: false, detail: "名称只能包含字母、数字、点、下划线、横线" };
  backupConfig();
  const args: string[] = ["mcp", "add", params.name];
  if (params.url) {
    args.push("--url", params.url);
  } else if (params.command) {
    args.push("--");
    args.push(params.command, ...(params.args ?? []));
  } else {
    return { ok: false, detail: "需要提供 command 或 url" };
  }
  for (const [k, v] of Object.entries(params.env ?? {})) {
    args.push("--env", `${k}=${v}`);
  }
  const r = await runCodex(args, 30000);
  if (r.code !== 0) return { ok: false, detail: `添加失败: ${r.out.slice(-300)}` };
  const v = await runCodex(["mcp", "get", params.name], 20000);
  info("toolhub", `已添加 MCP 服务器 ${params.name}`);
  return { ok: v.code === 0, detail: v.code === 0 ? `已添加 ${params.name}` : `已添加但验证失败: ${v.out.slice(-200)}` };
}

/** 删除 MCP 服务器。 */
export async function removeMcpServer(name: string): Promise<{ ok: boolean; detail: string }> {
  backupConfig();
  const r = await runCodex(["mcp", "remove", name], 20000);
  return { ok: r.code === 0, detail: r.code === 0 ? `已删除 ${name}` : `删除失败: ${r.out.slice(-300)}` };
}

function backupConfig(): string | null {
  const file = configTomlFile();
  try {
    if (fs.existsSync(file)) {
      const bak = `${file}.bak-${Date.now()}`;
      fs.copyFileSync(file, bak);
      return bak;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 启用/停用：改 config.toml 的 mcp_servers.<name>.enabled（依据官方配置参考），失败自动还原。 */
export async function toggleMcpServer(name: string, enabled: boolean): Promise<{ ok: boolean; detail: string }> {
  const file = configTomlFile();
  if (!fs.existsSync(file)) return { ok: false, detail: `未找到工人配置文件 ${file}` };
  const bak = backupConfig();
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  const secRe = new RegExp(`^\\[mcp_servers\\.${name.replace(/[.]/g, "\\.")}\\]\\s*$`);
  let idx = lines.findIndex((l) => secRe.test(l.trim()));
  if (idx < 0) return { ok: false, detail: `未找到 MCP 服务器 ${name}` };
  // 在该段内找 enabled 键
  let enabledLine = -1;
  for (let i = idx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("[")) break; // 下一段
    if (/^enabled\s*=/.test(t)) {
      enabledLine = i;
      break;
    }
  }
  if (enabledLine >= 0) lines[enabledLine] = `enabled = ${enabled ? "true" : "false"}`;
  else lines.splice(idx + 1, 0, `enabled = ${enabled ? "true" : "false"}`);
  try {
    fs.writeFileSync(file, lines.join("\n"), "utf8");
    const v = await runCodex(["mcp", "get", name], 20000);
    if (v.code !== 0) throw new Error(`写入后验证失败: ${v.out.slice(-200)}`);
    info("toolhub", `MCP ${name} 已${enabled ? "启用" : "停用"}（下一个任务生效）`);
    return { ok: true, detail: `已${enabled ? "启用" : "停用"} ${name}。对正在运行的任务不生效，下一个任务生效。` };
  } catch (e: any) {
    // 失败自动还原（需求 12.1）
    if (bak && fs.existsSync(bak)) {
      fs.copyFileSync(bak, file);
      warn("toolhub", `MCP 启停失败，已还原配置备份: ${e.message}`);
    }
    return { ok: false, detail: `启停失败（已还原）: ${e.message}` };
  }
}

/** 测试 MCP 连通：启动并列出工具，超时 15 秒（需求 12.1）。 */
export async function testMcpServer(name: string): Promise<{ ok: boolean; detail: string; tools?: string[] }> {
  const { servers } = await listMcpServers();
  const s = servers.find((x) => x.name === name);
  if (!s) return { ok: false, detail: `未找到 MCP 服务器 ${name}` };
  if (s.url) return { ok: false, detail: "HTTP 型 MCP 请由工人运行时自行连接，调度中心暂不直接探测" };
  if (!s.command) return { ok: false, detail: "该服务器缺少 command 配置" };
  return new Promise((resolve) => {
    let done = false;
    const isWin = process.platform === "win32";
    let child;
    try {
      child = spawn(isWin ? s.command! : s.command!, s.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, ...(s.env ?? {}) },
        shell: isWin,
      });
    } catch (e: any) {
      return resolve({ ok: false, detail: `无法启动: ${e.message}` });
    }
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve({ ok: false, detail: "15 秒内没有完成握手（超时）" });
      }
    }, 15000);
    let buf = "";
    child.stdout?.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result) {
            child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
          }
          if (msg.id === 2 && msg.result) {
            const tools = (msg.result.tools ?? []).map((t: any) => t.name);
            done = true;
            clearTimeout(timer);
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
            resolve({ ok: true, detail: `连接成功，工具 ${tools.length} 个`, tools });
          }
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    });
    child.on("error", (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, detail: `启动失败: ${e.message}` });
      }
    });
    child.on("close", (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, detail: `进程提前退出（码 ${code}）` });
      }
    });
    // MCP stdio 握手：initialize（JSON-RPC 2.0）
    child.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "dispatch-center", version: "2.0" } },
      }) + "\n"
    );
  });
}

// ───────────────────────── skills 导入（需求 12.2） ─────────────────────────

/** 预览将要导入的文件清单（需求 12.2：导入前显示清单）。 */
export function previewSkillsImport(source: { dir?: string; gitUrl?: string }): Promise<{ ok: boolean; detail: string; files: string[]; targetDir: string }> {
  return withSourceTree(source, (tree, _tmp) => {
    const files = tree.filter((f) => f.isFile).map((f) => f.rel);
    return { ok: true, detail: `共 ${files.length} 个文件`, files, targetDir: skillsDir() };
  });
}

interface TreeItem {
  rel: string;
  abs: string;
  isFile: boolean;
}

function walkTree(root: string, relPrefix = ""): TreeItem[] {
  const out: TreeItem[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    const abs = path.join(root, e.name);
    if (e.isDirectory()) {
      out.push({ rel, abs, isFile: false });
      out.push(...walkTree(abs, rel));
    } else if (e.isFile()) {
      out.push({ rel, abs, isFile: true });
    }
  }
  return out;
}

async function withSourceTree<T>(source: { dir?: string; gitUrl?: string }, fn: (tree: TreeItem[], tmpDir: string | null) => T): Promise<T> {
  let tmp: string | null = null;
  if (source.gitUrl) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-skills-"));
    const r = await new Promise<{ code: number; out: string }>((resolve) => {
      const isWin = process.platform === "win32";
      const cmd = isWin ? "git" : "git";
      execFile(cmd, ["clone", "--depth", "1", source.gitUrl!, tmp!], { timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ code: err ? 1 : 0, out: `${stdout}${stderr}`.trim() });
      });
    });
    if (r.code !== 0) throw new Error(`克隆仓库失败: ${r.out.slice(-300)}`);
  } else if (source.dir) {
    if (!fs.existsSync(source.dir)) throw new Error("本地目录不存在");
  } else {
    throw new Error("需要提供本地目录或 Git 仓库地址");
  }
  try {
    const root = source.gitUrl ? tmp! : source.dir!;
    return fn(walkTree(root), tmp);
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/** 导入 skills 到工人的用户级 skills 目录（$HOME/.agents/skills，官方文档 USER 作用域）。 */
export async function importSkills(source: { dir?: string; gitUrl?: string; subPath?: string }): Promise<{ ok: boolean; detail: string; files: string[] }> {
  return (await withSourceTree(source, (tree, tmp) => {
    let root = source.gitUrl ? tmp! : source.dir!;
    if (source.subPath) root = path.join(root, source.subPath);
    const files = walkTree(root).filter((f) => f.isFile);
    fs.mkdirSync(skillsDir(), { recursive: true });
    const targetName = path.basename(root) || "imported-skills";
    const dest = path.join(skillsDir(), targetName);
    fs.mkdirSync(dest, { recursive: true });
    const copied: string[] = [];
    for (const f of files) {
      const to = path.join(dest, f.rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(f.abs, to);
      copied.push(f.rel);
    }
    info("toolhub", `skills 导入完成：${copied.length} 个文件 → ${dest}`);
    return { ok: true, detail: `已导入 ${copied.length} 个文件到 ${dest}（下一个任务生效）`, files: copied };
  })) as { ok: boolean; detail: string; files: string[] };
}

import * as path from "node:path";
import { Criterion, CriterionKind } from "../tasks/store";
import { isSafeProjectRelPath } from "../util/paths";

/**
 * 验收标准 schema 与校验（需求 5.3）——代码里唯一的来源。
 * 四种 kind 的必填字段都在这里定义；校验发生在三处：
 *   ① 解析大脑输出时 ② 创建任务时 ③ 执行验收前（防旧数据）。
 * 校验失败的提示必须指明「哪条标准缺哪个字段」。
 */

export const CRITERION_KINDS: CriterionKind[] = ["web_console_clean", "web_url", "file_exists", "command_exit_0"];

export interface CriterionFieldSpec {
  kind: CriterionKind;
  label: string;
  requiredFields: { field: "url" | "path" | "command"; label: string; rules?: string[] }[];
  example: Record<string, string>;
}

/** 每种 kind 的必填字段与大脑提示词中的 JSON 示例（需求 5.3：每种 kind 给出带全部必填字段的示例）。 */
export const CRITERION_SCHEMA: CriterionFieldSpec[] = [
  {
    kind: "web_console_clean",
    label: "网页打开且控制台无报错",
    requiredFields: [],
    example: { id: "C1", text: "打开首页控制台无 error", kind: "web_console_clean", url: "" },
  },
  {
    kind: "web_url",
    label: "网页可以打开",
    requiredFields: [],
    example: { id: "C2", text: "首页能打开", kind: "web_url", url: "" },
  },
  {
    kind: "file_exists",
    label: "文件存在",
    requiredFields: [{ field: "path", label: "path（项目内相对路径）", rules: ["必须是项目内相对路径", "不得包含 ..", "不得是绝对路径"] }],
    example: { id: "C3", text: "存在 index.html", kind: "file_exists", path: "index.html" },
  },
  {
    kind: "command_exit_0",
    label: "命令执行成功（退出码 0）",
    requiredFields: [{ field: "command", label: "command（在项目目录执行的命令）" }],
    example: { id: "C4", text: "npm run build 成功", kind: "command_exit_0", command: "npm run build" },
  },
];

/** 大脑系统提示词里使用的 schema 说明片段（结构化输出示例，需求 5.3）。 */
export function criteriaPromptSection(): string {
  const lines = CRITERION_SCHEMA.map(
    (s) => `    - "${s.kind}"（${s.label}${s.requiredFields.length ? `；必填字段：${s.requiredFields.map((f) => f.label).join("、")}` : "；url 可留空"}）示例：${JSON.stringify(s.example)}`
  );
  return lines.join("\n");
}

/** 校验一条标准；返回错误列表（中文，指明哪条标准缺哪个字段）。 */
export function validateCriterion(c: any, index?: number): string[] {
  const label = (c && typeof c.id === "string" && c.id) ? `标准 ${c.id}` : `第 ${index !== undefined ? index + 1 : "?"} 条标准`;
  const errors: string[] = [];
  if (!c || typeof c !== "object") return [`${label}：不是对象`];
  if (!c.id || typeof c.id !== "string") errors.push(`${label}：缺少 id`);
  if (!c.text || typeof c.text !== "string") errors.push(`${label}：缺少 text（标准的中文描述）`);
  if (!c.kind || !CRITERION_KINDS.includes(c.kind)) {
    errors.push(`${label}：kind 必须是 ${CRITERION_KINDS.join(" / ")} 之一，实际为 ${JSON.stringify(c.kind ?? null)}`);
    return errors; // kind 都不认识时其余字段无从谈起
  }
  const spec = CRITERION_SCHEMA.find((s) => s.kind === c.kind)!;
  for (const f of spec.requiredFields) {
    const v = (c as any)[f.field];
    if (v === undefined || v === null || String(v).trim() === "") {
      errors.push(`${label}：${f.field} 必填（${f.label}）`);
    }
  }
  if (c.kind === "file_exists" && c.path && String(c.path).trim() !== "") {
    const p = String(c.path).trim();
    if (!isSafeProjectRelPath(p)) {
      errors.push(`${label}：path 必须是项目内相对路径，不得含 .. 或绝对路径，实际为 ${p}`);
    }
  }
  return errors;
}

/** 校验一组标准。 */
export function validateCriteria(list: any): string[] {
  if (!Array.isArray(list)) return ["criteria 必须是数组"];
  if (list.length === 0) return ["criteria 不能为空：至少给出一条可自动检查的验收标准"];
  const errors: string[] = [];
  const ids = new Set<string>();
  list.forEach((c, i) => {
    errors.push(...validateCriterion(c, i));
    if (c && typeof c.id === "string" && c.id) {
      if (ids.has(c.id)) errors.push(`标准 id 重复: ${c.id}`);
      ids.add(c.id);
    }
  });
  return errors;
}

/** 把大脑给的标准草稿整理为合法 Criterion（在 validateCriteria 通过后调用）。 */
export function normalizeCriteria(drafts: any[]): Criterion[] {
  return drafts.map((c, i) => ({
    id: String(c.id ?? `C${i + 1}`),
    text: String(c.text ?? ""),
    kind: c.kind as CriterionKind,
    url: c.url ? String(c.url) : undefined,
    path: c.path ? String(c.path) : undefined,
    command: c.command ? String(c.command) : undefined,
  }));
}

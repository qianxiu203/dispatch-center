import * as crypto from "node:crypto";

/**
 * 循环签名（需求 4.1-M2）：
 * 签名 = 哈希(失败标准 id + 错误类型 + 规范化后的关键错误文本)。
 * 规范化去掉时间戳、行号、随机 id 等噪音，使「同一个问题」得到同一个签名。
 * 内容为空的签名固定为 EMPTY，EMPTY 永远不是合法的修复输入（L1）。
 */

/** 空签名常量：空内容永远不允许进入修复循环。 */
export const EMPTY_SIGNATURE = "EMPTY";

/** 规范化关键错误文本：去时间戳、行号、随机 id、多余空白。 */
export function normalizeErrorText(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+(z|[+-]\d{2}:?\d{2})?/g, "#ts") // ISO 时间戳
    .replace(/\b[0-9a-f]{8,}\b/g, "#id") // 16 进制随机 id / hash
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "#host") // ip:port
    .replace(/:\d+/g, ":#") // 行号 / 端口号
    .replace(/\d+/g, "#")
    .replace(/\/[\w.\-/@]+\.(ts|tsx|js|jsx|mjs|json|css|html)\b/g, "#file") // 带行号已去，文件名保留会话变化 → 一并归一
    .replace(/\s+/g, " ")
    .trim();
}

/** 生成循环签名；关键文本为空时返回 EMPTY。 */
export function signatureOf(criterionId: string, errorType: string, keyText: string): string {
  const norm = normalizeErrorText(keyText);
  if (!norm) return EMPTY_SIGNATURE;
  const h = crypto.createHash("sha1").update(`${criterionId}|${errorType}|${norm}`).digest("hex");
  return h.slice(0, 16);
}

/** 从问题列表生成组合签名（同一轮验收的全部问题视为一个签名）。 */
export function signatureOfProblems(problems: { criterionId?: string; summary?: string; source?: string; message?: string }[]): string {
  if (!problems || problems.length === 0) return EMPTY_SIGNATURE;
  // 关键内容在 summary（runner.ProjectProblem）；message/source 兼容旧调用
  const contents = problems.map((p) => normalizeErrorText(p.summary ?? p.message ?? p.source ?? ""));
  // 全部问题内容为空 → EMPTY（criterionId 只是编号，不算内容；M2/L1：EMPTY 永不合法）
  if (contents.every((c) => !c)) return EMPTY_SIGNATURE;
  const parts = problems.map((p, i) => `${p.criterionId ?? ""}|${contents[i]}`).sort();
  return crypto.createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 16);
}

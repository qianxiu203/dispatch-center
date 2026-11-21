/**
 * 大脑 v2（需求 3/7.2/9/4.1-M9/L11）：
 * - OpenAI 兼容接口流式调用（沿用一期 SseParser）。
 * - 协议扩展：
 *   chat / clarify / requirement（带 schema 校验的 criteria）/ plan /
 *   intent（任务执行中对使用者消息的意图分类）/ answer（对工人提问的代答）/
 *   memory_consolidation（任务结束后的记忆整理，L13）/ summary（上下文压缩摘要，L10）。
 * - M9 重试：只有可恢复错误（网络超时、5xx、限流 429）才重试，退避 1s/4s/16s，最多 3 次；
 *   配置错误、401/403、参数校验失败、其他 4xx 一律不重试直接失败。
 * - L11：单个回合内大脑调用次数上限 8；相同「类型+参数」的调用第 2 次出现，终止本回合。
 * - M7：心跳/看门狗/进度类事件永远不唤醒大脑——大脑只被 orchestrator 的显式路径调用，
 *   自动代答路径在调用前用 events.canTriggerAction 检查事件因果深度。
 */
import { streamChat, ChatMessage } from "../llm/openai";
import { getConfig } from "../config";
import { criteriaPromptSection } from "./criteria";
import { redact, warn } from "../logger";

export interface CriterionDraft {
  id: string;
  text: string;
  kind: string;
  url?: string;
  path?: string;
  command?: string;
}

export type BrainReply =
  | { type: "chat"; text: string }
  | { type: "clarify"; text: string }
  | { type: "requirement"; text: string; requirement: string; criteria: CriterionDraft[] }
  | { type: "plan"; text: string; steps: { id: string; title: string; instruction: string }[] }
  | { type: "intent"; text: string; intent: "query_progress" | "new_requirement" | "control" | "answer" | "chitchat"; confidence: number; target?: string }
  | { type: "answer"; text: string; answer: string; unsure: boolean }
  | { type: "memory_consolidation"; text: string; add: string[]; update: { id: string; text: string }[]; delete: string[] }
  | { type: "summary"; text: string };

export const BRAIN_SYSTEM_PROMPT = `你是「调度中心」的大脑。使用者是零基础用户，只通过对话提出开发需求；你负责理解需求、拆解任务、指挥命令行编码工具（工人，codex CLI）完成开发，并依据验收标准自动验收。

你必须只输出一个 JSON 对象（第一个字符是 { ，禁止 markdown 代码围栏、禁止多余文字），字段顺序固定为 type 在前、text 在其次（text 是给用户看的中文文字）。可选 type：
- {"type":"chat","text":"..."}：一般回答与闲聊。
- {"type":"clarify","text":"..."}：需求不清时向使用者提问；一次最多问一个问题。
- {"type":"requirement","text":"...","requirement":"需求的完整复述","criteria":[...]}：需求明确后，复述需求并给出可由程序自动检查的验收标准。criteria 的 kind 只能是以下四种，每种都给出带全部必填字段的 JSON 示例：
${criteriaPromptSection()}
  网页项目至少包含 web_url 与 web_console_clean（url 留空即可，调度中心用内置预览打开项目里的 index.html）；普通项目至少包含 file_exists 或 command_exit_0。
- {"type":"plan","text":"...","steps":[{"id":"S1","title":"...","instruction":"给工人的具体中文指令"}]}：需求确认后拆解为 2~6 个循序渐进的步骤，instruction 要具体到文件与功能，并告知工人只能在项目目录内创建/修改文件。

规则：
- 使用者提出新需求时，必须先输出 clarify 或 requirement；只有系统提示说明需求已确认才允许输出 plan。
- requirement 的 text 字段必须输出。所有 JSON 都必须有非空 text 字段。
- 已进入执行阶段时，不要输出 requirement/plan，用 chat 汇报进展或回答问题。
- 所有文字使用简体中文。`;

/** 意图分类系统提示（需求 7.2：任务执行中使用者发消息的意图分类，输出受 schema 约束）。 */
export const INTENT_SYSTEM_PROMPT = `你是「调度中心」的意图分类器。根据当前项目状态判断使用者消息的意图，只输出一个 JSON 对象：
{"type":"intent","text":"一句话说明你的判断","intent":"query_progress|new_requirement|control|answer|chitchat","confidence":0到1的小数}
- query_progress：询问任务进展（如"做到哪了""还要多久"）。
- new_requirement：提出新的开发需求（即使任务在跑，也只能排队，不插入正在运行的任务）。
- control：控制指令（暂停/取消/恢复某个任务）。target 填任务关键词或 id（放在 text 之后附加字段 "target":"..."）。
- answer：对某个待决卡片/提问的回答（如"用 React""再试一次"）。
- chitchat：闲聊或一般咨询。
置信度低于 0.6 时 intent 填 "chitchat" 并在 text 里向使用者反问一句，不得猜着执行。全部用简体中文。`;

/** 工人提问代答提示（需求 L4：大脑代答；回答不确定必须升级给使用者）。 */
export function workerQuestionPrompt(question: string, taskContext: string): ChatMessage[] {
  return [
    {
      role: "user" as const,
      content: `工人（codex）在执行任务时提出了一个问题，请根据任务上下文代答。若你无法给出确定答案，answer 必须输出"不确定"且 unsure=true（系统会转问使用者）。
只输出 JSON：{"type":"answer","text":"给工人的回答","answer":"回答正文","unsure":true|false}
【任务上下文】${taskContext}
【工人的问题】${question}`,
    },
  ];
}

/** 记忆整理提示（需求 9.5/L13：输出结构化变更，程序校验后应用；只记事实，不记猜测）。 */
export function memoryConsolidationPrompt(currentMemory: string, taskSummary: string): ChatMessage[] {
  return [
    {
      role: "user" as const,
      content: `任务已结束，请整理记忆。只记录使用者明确说过的、和任务产出的事实，不记猜测；不要记录任何密钥。
只输出 JSON：{"type":"memory_consolidation","text":"一句话说明整理结果","add":["新增记忆条目"],"update":[{"id":"M2","text":"修改后的内容"}],"delete":["M3"]}
add/update/delete 都可以为空数组。每条记忆用一行中文，结尾可注明来源。
【现有记忆】
${currentMemory || "（空）"}
【本次任务摘要】
${taskSummary}`,
    },
  ];
}

/** 上下文压缩摘要提示（需求 9.3/L10：保留已确认需求、决策、未完成事项、使用者偏好）。 */
export function compactionPrompt(older: string): ChatMessage[] {
  return [
    {
      role: "user" as const,
      content: `以下是对话的较早内容，请压缩成一份摘要，必须保留：已确认的需求、做出的决策、未完成事项、使用者明确表达的偏好。
只输出 JSON：{"type":"summary","text":"摘要正文"}
【较早的对话】
${older}`,
    },
  ];
}

/** 验收标准重新生成提示（L2/L3：带着具体校验错误让大脑重新生成）。 */
export function criteriaRegenPrompt(requirement: string, badCriteria: any[], errors: string[]): ChatMessage[] {
  return [
    {
      role: "user" as const,
      content: `你上一轮给出的验收标准未通过校验，请重新生成。只输出 requirement 类型的完整 JSON（含 text/requirement/criteria）。
【校验错误（必须逐条修正）】
${errors.map((e) => "- " + e).join("\n")}
【上一轮的 criteria】
${JSON.stringify(badCriteria)}
【需求】${requirement}`,
    },
  ];
}

// ───────────────────────── 解析 ─────────────────────────

/** 去掉可能的代码围栏与前后空白，提取首个 JSON 对象文本。 */
function stripFences(text: string): string {
  let t = (text ?? "").trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  return t;
}

function validKinds(): Set<string> {
  return new Set(["web_console_clean", "web_url", "file_exists", "command_exit_0"]);
}

/** 完整解析大脑回复；解析失败时把原文当作 chat。 */
export function parseBrainReply(full: string): BrainReply {
  let obj: any;
  try {
    obj = JSON.parse(stripFences(full));
  } catch {
    return { type: "chat", text: (full ?? "").trim() || "（大脑返回了无法解析的内容）" };
  }
  const kinds = validKinds();
  switch (obj.type) {
    case "clarify":
      return { type: "clarify", text: String(obj.text ?? "") };
    case "requirement": {
      const rawCriteria: any[] = Array.isArray(obj.criteria) ? obj.criteria : [];
      const criteria: CriterionDraft[] = rawCriteria
        .filter((c) => c && typeof c.text === "string" && kinds.has(c.kind))
        .map((c, i) => ({
          id: String(c.id ?? `C${i + 1}`),
          text: String(c.text),
          kind: String(c.kind),
          url: c.url ? String(c.url) : undefined,
          path: c.path ? String(c.path) : undefined,
          command: c.command ? String(c.command) : undefined,
        }));
      return {
        type: "requirement",
        text: String(obj.text ?? ""),
        requirement: String(obj.requirement ?? obj.text ?? ""),
        criteria,
      };
    }
    case "plan": {
      const steps = (Array.isArray(obj.steps) ? obj.steps : [])
        .filter((s: any) => s && (typeof s.instruction === "string" || typeof s.title === "string"))
        .map((s: any, i: number) => ({
          id: String(s.id ?? `S${i + 1}`),
          title: String(s.title ?? `步骤${i + 1}`),
          instruction: String(s.instruction ?? s.title ?? ""),
        }));
      return { type: "plan", text: String(obj.text ?? ""), steps };
    }
    case "intent": {
      const intents = ["query_progress", "new_requirement", "control", "answer", "chitchat"];
      const intent = intents.includes(obj.intent) ? obj.intent : "chitchat";
      const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0.5;
      return { type: "intent", text: String(obj.text ?? ""), intent: intent as any, confidence, target: obj.target ? String(obj.target) : undefined };
    }
    case "answer":
      return { type: "answer", text: String(obj.text ?? ""), answer: String(obj.answer ?? ""), unsure: !!obj.unsure };
    case "memory_consolidation":
      return {
        type: "memory_consolidation",
        text: String(obj.text ?? ""),
        add: (Array.isArray(obj.add) ? obj.add : []).map(String),
        update: (Array.isArray(obj.update) ? obj.update : []).filter((u: any) => u && u.id && u.text).map((u: any) => ({ id: String(u.id), text: String(u.text) })),
        delete: (Array.isArray(obj.delete) ? obj.delete : []).map(String),
      };
    case "summary":
      return { type: "summary", text: String(obj.text ?? "") };
    default:
      return { type: "chat", text: String(obj.text ?? (full ?? "").trim()) };
  }
}

// ───────────────────────── M9 重试 ─────────────────────────

/** 判断错误是否可重试（M9：网络超时、5xx、限流 429 才重试；配置错误/401/403/参数错误/其他 4xx 不重试）。 */
export function isRetryableBrainError(e: any): boolean {
  const msg = String(e?.message ?? e ?? "");
  if (/超时|timeout|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed/i.test(msg)) return true;
  const m = msg.match(/HTTP (\d{3})/);
  if (m) {
    const code = parseInt(m[1], 10);
    return code >= 500 || code === 429;
  }
  if (/(401|403)/.test(msg)) return false;
  return false;
}

const RETRY_DELAYS_MS = [1000, 4000, 16000]; // M9：指数退避 1s、4s、16s

// ───────────────────────── 调用入口 ─────────────────────────

export interface BrainCallOptions {
  messages: ChatMessage[];
  onDelta?: (t: string) => void;
  signal?: AbortSignal;
  /** 记录一次大脑调用（供看门狗计数与 L11 去重；传入本回合的注册器）。 */
  turn?: BrainTurn;
}

/** 调用大脑（带 M9 重试）；返回完整文本。 */
export async function callBrain(opts: BrainCallOptions): Promise<string> {
  if (opts.turn) opts.turn.register(opts.messages);
  const cfg = getConfig();
  let attempt = 0;
  for (;;) {
    try {
      return await streamChat({
        baseUrl: cfg.brain.baseUrl,
        apiKey: cfg.brain.apiKey,
        model: cfg.brain.model,
        messages: opts.messages,
        onDelta: opts.onDelta,
        signal: opts.signal,
      });
    } catch (e: any) {
      const retryable = isRetryableBrainError(e);
      if (retryable && attempt < 3) {
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        attempt += 1;
        warn("brain", `大脑调用失败（${redact(e.message)}），${delay}ms 后第 ${attempt}/3 次重试`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
}

/**
 * L11：大脑单回合调用预算。
 * 单个回合内调用次数上限 8；相同「类型 + 参数摘要」的调用第 2 次出现，终止本回合。
 */
export class BrainTurn {
  private calls = 0;
  private fingerprints = new Set<string>();
  readonly maxCalls = 8;

  /** 注册一次调用；重复指纹返回 false（调用方必须终止本回合）。 */
  register(messages: ChatMessage[]): boolean {
    if (this.calls >= this.maxCalls) return false;
    const fp = this.fingerprint(messages);
    if (this.fingerprints.has(fp)) return false;
    this.fingerprints.add(fp);
    this.calls += 1;
    return true;
  }

  get used(): number {
    return this.calls;
  }

  private fingerprint(messages: ChatMessage[]): string {
    return messages.map((m) => `${m.role}:${(m.content ?? "").length}:${(m.content ?? "").slice(0, 200)}`).join("|");
  }
}

/** 渐进解析（转发实现）。 */
export { extractTextProgressive } from "./extract";

/**
 * 大脑（需求 2/6.1）：接入 OpenAI 兼容接口的大语言模型。
 * 职责：理解需求、一次最多一个澄清问题、生成「需求 + 验收标准」、拆解任务步骤、与工人沟通、总结结论。
 *
 * 输出协议：要求大脑输出单个 JSON 对象（第一个字符就是 {，不要代码围栏）：
 *   {"type":"chat","text":"闲聊/一般回答"}
 *   {"type":"clarify","text":"向使用者提的最多一个澄清问题"}
 *   {"type":"requirement","text":"给使用者的说明","requirement":"需求复述",
 *      "criteria":[{"id":"C1","text":"可自动检查的通过条件","kind":"web_console_clean|web_url|file_exists|command_exit_0","url":"...","path":"...","command":"..."}]}
 *   {"type":"plan","text":"简短说明","steps":[{"id":"S1","title":"...","instruction":"给工人的具体指令"}]}
 *
 * 流式体验：text 字段放在最前面并优先输出，前端通过 extractTextProgressive 在 JSON 尚未结束时
 * 就把 text 的内容流式展示（任务要求 4：必须流式）。
 */
import { streamChat, ChatMessage } from "../llm/openai";
import { getConfig } from "../config";

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
  | { type: "plan"; text: string; steps: { id: string; title: string; instruction: string }[] };

export const BRAIN_SYSTEM_PROMPT = `你是「调度中心」的大脑。使用者是零基础用户，只通过对话提出开发需求；你负责理解需求、拆解任务、指挥命令行编码工具（工人，如 codex CLI）完成开发，并依据验收标准自动验收。

你必须只输出一个 JSON 对象（第一个字符是 { ，禁止 markdown 代码围栏、禁止多余文字），字段顺序固定为 type 在前、text 在其次（text 是给用户看的中文文字）。可选 type：
- {"type":"chat","text":"..."}：一般回答与闲聊。
- {"type":"clarify","text":"..."}：需求不清时向使用者提问；一次最多问一个问题，不要连环追问。
- {"type":"requirement","text":"...","requirement":"需求的完整复述","criteria":[{"id":"C1","text":"...","kind":"..."}]}：需求明确后，复述需求并给出可由程序自动检查的验收标准。kind 只能是：
    "web_console_clean"（打开网页 url，要求控制台无 error、无未捕获异常、无失败请求；网页项目必选）
    "web_url"（网页 url 能打开）
    "file_exists"（文件存在，path 为项目内相对路径）
    "command_exit_0"（在项目目录运行 command，退出码为 0，如 npm run build）
  网页项目至少包含 web_url 与 web_console_clean；普通项目至少包含 file_exists 或 command_exit_0。
  网页验收标准的 url 一般留空即可：调度中心内置项目静态预览（http://127.0.0.1:<端口>/preview/ 会自动打开项目里的 index.html）；
  若项目需要 dev server，url 填写工人将启动的服务地址，并让工人在指令里启动它。
- {"type":"plan","text":"...","steps":[{"id":"S1","title":"...","instruction":"给工人的具体中文指令"}]}：确认后把需求拆解为 2~6 个循序渐进的步骤，instruction 要具体到文件与功能，并告知工人只能在项目目录内创建/修改文件。

规则：
- 使用者提出新需求时，必须先输出 clarify 或 requirement；只有使用者已在需求确认卡片上点过确认（系统提示会说明）才允许输出 plan。禁止跳过需求确认直接输出 plan。
- requirement 的 text 字段必须输出（是对使用者说的话，哪怕一句"请确认下方需求"）。所有 JSON 都必须有非空 text 字段。
- 使用者描述含糊时先用 clarify；需求明确时直接给 requirement，不要拖沓。
- 已进入执行阶段时（系统提示会说明），不要输出 requirement/plan，用 chat 汇报进展或回答问题。
- 所有文字使用简体中文。`;

/** 渐进式提取 JSON 里 depth-1 的 "type" 与 "text" 字段（流式期间 JSON 可能不完整）。 */
export function extractTextProgressive(buffer: string): { type?: string; text: string; textComplete: boolean; started: boolean } {
  let depth = 0;
  let inString = false;
  let escape = false;
  let result = { type: undefined as string | undefined, text: "", textComplete: false, started: false };
  let i = 0;
  let capture: "type" | "text" | null = null;
  let valueStart = -1;

  const decodeValue = (start: number): { value: string; end: number; closed: boolean } => {
    // start 指向开引号后第一个字符
    let out = "";
    let j = start;
    while (j < buffer.length) {
      const ch = buffer[j];
      if (escape) {
        // 处理常见转义；\uXXXX 需要后续字符，未到齐时先按原样保留
        if (ch === "n") out += "\n";
        else if (ch === "t") out += "\t";
        else if (ch === "r") out += "\r";
        else if (ch === '"') out += '"';
        else if (ch === "\\") out += "\\";
        else if (ch === "/") out += "/";
        else if (ch === "u") {
          const hex = buffer.slice(j + 1, j + 5);
          if (hex.length === 4) {
            out += String.fromCharCode(parseInt(hex, 16));
            j += 4;
          } else {
            out += "\\u";
          }
        } else out += ch;
        escape = false;
        j++;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        j++;
        continue;
      }
      if (ch === '"') return { value: out, end: j + 1, closed: true };
      out += ch;
      j++;
    }
    return { value: out, end: j, closed: false };
  };

  while (i < buffer.length) {
    const ch = buffer[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
        if (capture) {
          const dec = decodeValue(valueStart);
          if (capture === "text") result.text = dec.value;
          else result.type = dec.value;
          result.textComplete = capture === "text" ? dec.closed : result.textComplete;
          result.started = true;
          capture = null;
        }
      }
      i++;
      continue;
    }
    if (ch === '"') {
      // 尝试识别 depth-1 的 "type"/"text" 键
      if (depth === 1 && !capture) {
        const word = buffer.slice(i, i + 6);
        if (word === '"type"' || word === '"text"' || (word.slice(0, 5) === '"text' && buffer[i + 5] === '"')) {
          const key = word === '"type"' ? "type" : "text";
          // 找冒号
          let j = i + key.length + 2;
          while (j < buffer.length && /\s/.test(buffer[j])) j++;
          if (buffer[j] === ":") {
            j++;
            while (j < buffer.length && /\s/.test(buffer[j])) j++;
            if (buffer[j] === '"') {
              inString = true;
              capture = key;
              valueStart = j + 1;
              i = j + 1;
              continue;
            }
          }
        }
      }
      inString = true;
      escape = false;
      i++;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    i++;
  }
  // 字符串尚未闭合时也要输出已捕获的文本（流式进行中）
  if (capture === "text" && !result.textComplete) {
    const dec = decodeValue(valueStart);
    result.text = dec.value;
    result.started = true;
  }
  return result;
}

/** 去掉可能的代码围栏与前后空白，提取首个 JSON 对象文本。 */
function stripFences(text: string): string {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  return t;
}

/** 完整解析大脑回复；解析失败时把原文当作 chat。 */
export function parseBrainReply(full: string): BrainReply {
  let obj: any;
  try {
    obj = JSON.parse(stripFences(full));
  } catch {
    return { type: "chat", text: full.trim() || "（大脑返回了无法解析的内容）" };
  }
  switch (obj.type) {
    case "clarify":
      return { type: "clarify", text: String(obj.text ?? "") };
    case "requirement": {
      const rawCriteria: any[] = Array.isArray(obj.criteria) ? obj.criteria : [];
      const validKinds = new Set(["web_console_clean", "web_url", "file_exists", "command_exit_0"]);
      const criteria: CriterionDraft[] = rawCriteria
        .filter((c) => c && typeof c.text === "string" && validKinds.has(c.kind))
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
        .filter((s: any) => s && (typeof s.instruction === "string" || typeof s.detail === "string"))
        .map((s: any, i: number) => ({
          id: String(s.id ?? `S${i + 1}`),
          title: String(s.title ?? `步骤${i + 1}`),
          instruction: String(s.instruction ?? s.detail ?? s.title ?? ""),
        }));
      return { type: "plan", text: String(obj.text ?? ""), steps };
    }
    default:
      return { type: "chat", text: String(obj.text ?? full.trim()) };
  }
}

export interface BrainCallOptions {
  messages: ChatMessage[];
  onDelta?: (t: string) => void;
  signal?: AbortSignal;
}

/** 调用大脑：流式回调 text 增量，返回完整文本。 */
export async function callBrain(opts: BrainCallOptions): Promise<string> {
  const cfg = getConfig();
  return streamChat({
    baseUrl: cfg.brain.baseUrl,
    apiKey: cfg.brain.apiKey,
    model: cfg.brain.model,
    messages: opts.messages,
    onDelta: opts.onDelta,
    signal: opts.signal,
  });
}

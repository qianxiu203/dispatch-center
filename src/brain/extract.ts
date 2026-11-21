/**
 * 渐进式提取 JSON 里 depth-1 的 "type" 与 "text" 字段（流式期间 JSON 可能不完整）。
 * 自一期沿用：大脑按协议输出 JSON，text 字段在最前，前端在 JSON 未结束时就流式展示 text。
 */

export function extractTextProgressive(
  buffer: string
): { type?: string; text: string; textComplete: boolean; started: boolean } {
  let depth = 0;
  let inString = false;
  let escape = false;
  const result = { type: undefined as string | undefined, text: "", textComplete: false, started: false };
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
      if (depth === 1 && !capture) {
        const word = buffer.slice(i, i + 6);
        if (word === '"type"' || word === '"text"' || (word.slice(0, 5) === '"text' && buffer[i + 5] === '"')) {
          const key = word === '"type"' ? "type" : "text";
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
  if (capture === "text" && !result.textComplete) {
    const dec = decodeValue(valueStart);
    result.text = dec.value;
    result.started = true;
  }
  return result;
}

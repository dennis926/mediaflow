/**
 * 把大模型返回的"差不多的 JSON"抢救成合法 JSON。
 *
 * 实测失败原因（deepseek-flash 这类推理模型，JSON 任务约 16% 直接抛错）：
 * 1. 用 ```json 代码块包起来，或代码块没闭合就断了；
 * 2. JSON 前后夹带解释文字（"好的，以下是结果："）；
 * 3. 尾随逗号、单引号、注释；
 * 4. 中文全角标点（引号/冒号/逗号）被模型从中文里带进结构；
 * 5. 输出被 max_tokens 截断，JSON 结构缺尾巴。
 *
 * 这里按"从保守到激进"的顺序尝试修复，并返回做过哪些修复，便于排查。
 */
export interface SalvagedJson {
  value: unknown;
  /** 实际用到的修复手段，空数组表示原样就是合法 JSON */
  repairs: string[];
}

/**
 * 顶层是数组时按任务语义包一层：对象数组 → variants（多平台改写）、字符串数组 → titles（标题建议）。
 * 模型经常只给数组不给外层键，这里统一兜住。
 */
function wrapTopLevelArray(value: unknown[]): Record<string, unknown> | null {
  if (value.length === 0) return null;
  if (value.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item))) {
    return { variants: value };
  }
  if (value.every((item) => typeof item === 'string')) {
    return { titles: value };
  }
  return null;
}

/** 去掉字符串字面量之外的注释与多余空白（模型偶尔会加注释）。 */
function stripComments(input: string): string {
  let out = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 字符串外的中文全角标点换成半角（模型写中文时最容易带出来）。 */
function normalizeWidePunctuation(input: string): string {
  const map: Record<string, string> = {
    '：': ':', '，': ',', '；': ';', '“': '"', '”': '"', '‘': "'", '’': "'", '（': '(', '）': ')', '【': '[', '】': ']',
  };
  let out = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += input[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    out += map[ch] ?? ch;
  }
  return out;
}

/** 去掉对象/数组结尾的多余逗号。 */
function stripTrailingCommas(input: string): string {
  return input.replace(/,\s*([}\]])/g, '$1');
}

/** 单引号当字符串定界符时换成双引号（字符串内不处理）。 */
function normalizeQuotes(input: string): string {
  if (!/'\s*:/.test(input) && !/:\s*'/.test(input)) return input;
  let out = '';
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inDouble) {
      out += ch;
      if (ch === '\\') {
        out += input[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    if (inSingle) {
      if (ch === '\\') {
        const next = input[i + 1] ?? '';
        out += next === "'" ? "'" : `\\${next}`;
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
        out += '"';
      } else if (ch === '"') {
        out += '\\"';
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += '"';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 补全被截断的 JSON 尾巴：把未闭合的字符串、对象、数组收口。
 * 只用于"模型被 max_tokens 截断"的场景，能救回前面的字段。
 */
function closeTruncated(input: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (stack.length === 0 && !inString) return null;
  let out = input;
  if (inString) out += '"';
  // 截断处常常正好停在半条记录上：先丢掉尾部不完整的键值对再收口。
  for (const closer of stack.reverse()) out += closer;
  return out;
}

/** 从一段文字里取出第一个完整配对的 JSON 结构。 */
function extractBalanced(input: string, open: '{' | '['): { text: string; complete: boolean } | null {
  const start = input.indexOf(open);
  if (start === -1) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) return { text: input.slice(start, i + 1), complete: true };
    }
  }
  return { text: input.slice(start), complete: false };
}

function tryParse(text: string): unknown | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function salvageJson(raw: string): SalvagedJson | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const direct = tryParse(trimmed);
  if (direct !== undefined) {
    if (Array.isArray(direct)) {
      const wrapped = wrapTopLevelArray(direct);
      return wrapped ? { value: wrapped, repairs: ['wrap-array'] } : { value: direct, repairs: [] };
    }
    return { value: direct, repairs: [] };
  }

  const candidates: Array<{ text: string; label: string }> = [];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push({ text: fenced[1].trim(), label: 'strip-fence' });
  const unclosedFence = trimmed.match(/```(?:json)?\s*([\s\S]*)$/i);
  if (unclosedFence) candidates.push({ text: unclosedFence[1].trim(), label: 'strip-unclosed-fence' });
  for (const open of ['{', '['] as const) {
    const balanced = extractBalanced(trimmed, open);
    if (balanced) candidates.push({ text: balanced.text, label: balanced.complete ? 'extract-balanced' : 'extract-truncated' });
  }
  candidates.push({ text: trimmed, label: 'raw' });

  for (const candidate of candidates) {
    const steps: Array<{ apply: (input: string) => string; label: string }> = [
      { apply: stripTrailingCommas, label: 'trailing-comma' },
      { apply: (input) => stripTrailingCommas(stripComments(input)), label: 'comments' },
      { apply: (input) => stripTrailingCommas(normalizeWidePunctuation(input)), label: 'wide-punctuation' },
      { apply: (input) => stripTrailingCommas(normalizeQuotes(input)), label: 'single-quotes' },
    ];
    let attempt = candidate.text;
    const repairs: string[] = [candidate.label];
    for (const step of steps) {
      const parsed = tryParse(attempt);
      if (parsed !== undefined) return { value: parsed, repairs: repairs.filter((r) => r !== 'raw') };
      attempt = step.apply(attempt);
      repairs.push(step.label);
    }
    const parsed = tryParse(attempt);
    if (parsed !== undefined) return { value: parsed, repairs: repairs.filter((r) => r !== 'raw') };
    const closed = closeTruncated(attempt);
    if (closed) {
      const revived = tryParse(closed);
      if (revived !== undefined) return { value: revived, repairs: [...repairs.filter((r) => r !== 'raw'), 'close-truncated'] };
    }
  }
  return null;
}

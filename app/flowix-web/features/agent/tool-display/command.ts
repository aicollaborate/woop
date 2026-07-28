import { COMMAND_KEYS, normalizeToolInput, stringField } from "./common";

export type AgentCommandOperator = "&&" | "||" | ";" | "|";

export interface AgentCommandItem {
  op?: AgentCommandOperator;
  command: string;
  args: string[];
  env: string[];
  raw: string;
  wrapper?: {
    label: string;
    payload: AgentCommandList;
  };
}

export interface AgentCommandList {
  items: AgentCommandItem[];
}

interface CommandToken {
  text: string;
  quoted: boolean;
  op?: AgentCommandOperator;
}

const COMMAND_SCRIPT_FLAGS = new Set([
  "-c",
  "-lc",
  "-ic",
  "-lic",
  "-e",
]);

const COMMAND_WRAPPER_NAMES = new Set([
  "bash",
  "dash",
  "fish",
  "ksh",
  "node",
  "perl",
  "php",
  "python",
  "python2",
  "python3",
  "ruby",
  "sh",
  "zsh",
]);

function basenameCommandName(command: string): string {
  return command.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? command;
}

/**
 * 公开的 basename 提取 ── 给前端渲染用 (例: thread card 展示命令名)。
 * 把 Windows / POSIX 路径末尾的文件名/可执行名取出, 非路径输入保持原样。
 *
 *   basenameCommandNameForDisplay("C:\\Windows\\...\\powershell.exe")
 *     === "powershell.exe"
 *   basenameCommandNameForDisplay("/usr/local/bin/node")
 *     === "node"
 *   basenameCommandNameForDisplay("rg")
 *     === "rg"
 *
 * 跟模块内部 `basenameCommandName` 不同: 内部版假设输入已 tokenize,
 * 不带 `\`, 也不关心 unicode 安全; 这里我们保留 backslash 兼容 + 对
 * 路径分隔符做显式检测 ── 调用方可以决定什么时候才走 basename。
 */
export function basenameCommandNameForDisplay(command: string): string {
  return basenameCommandName(command);
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function tokenizeCommand(command: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let text = "";
  let quote: "'" | '"' | null = null;
  let quoted = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  const push = () => {
    if (!text) return;
    tokens.push({ text, quoted });
    text = "";
    quoted = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (ch === "\\" && next !== undefined) {
      text += next;
      i += 1;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        text += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (parenDepth > 0 || bracketDepth > 0 || braceDepth > 0) {
        text += ch;
        continue;
      }
      push();
      continue;
    }

    if (ch === "(") {
      parenDepth += 1;
      text += ch;
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      text += ch;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
      text += ch;
      continue;
    }
    if (ch === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      text += ch;
      continue;
    }
    if (ch === "{") {
      braceDepth += 1;
      text += ch;
      continue;
    }
    if (ch === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      text += ch;
      continue;
    }

    const atTopLevel =
      parenDepth === 0 && bracketDepth === 0 && braceDepth === 0;

    if (
      atTopLevel &&
      ((ch === "&" && next === "&") || (ch === "|" && next === "|"))
    ) {
      push();
      tokens.push({ text: ch + next, quoted: false, op: ch + next as AgentCommandOperator });
      i += 1;
      continue;
    }

    if (atTopLevel && (ch === ";" || ch === "|")) {
      push();
      tokens.push({ text: ch, quoted: false, op: ch as AgentCommandOperator });
      continue;
    }

    text += ch;
  }
  push();
  return tokens;
}

function tokenText(tokens: CommandToken[]): string {
  return tokens.map((token) => token.text).join(" ").trim();
}

function parseCommandTokens(
  tokens: CommandToken[],
  op: AgentCommandOperator | undefined,
  depth: number,
): AgentCommandItem | null {
  const words = tokens.filter((token) => !token.op && token.text);
  if (words.length === 0) return null;

  const script = findWrapperScript(words);
  const env: string[] = [];
  let commandIndex = 0;
  while (commandIndex < words.length && isEnvAssignment(words[commandIndex].text)) {
    env.push(words[commandIndex].text);
    commandIndex += 1;
  }
  const command = words[commandIndex]?.text;
  if (!command) return null;

  const item: AgentCommandItem = {
    op,
    command,
    args: words.slice(commandIndex + 1).map((token) => token.text),
    env,
    raw: tokenText(words),
  };

  if (script && depth < 2) {
    const payload = parseCommandString(script.payload, depth + 1);
    if (payload) {
      item.wrapper = {
        label: tokenText(words.slice(0, script.payloadIndex)),
        payload,
      };
    }
  }

  return item;
}

function findWrapperScript(
  tokens: CommandToken[],
): { payload: string; payloadIndex: number } | null {
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const name = basenameCommandName(tokens[i].text).toLowerCase();
    if (!COMMAND_WRAPPER_NAMES.has(name)) continue;

    for (let j = i + 1; j < tokens.length - 1; j += 1) {
      const flag = tokens[j].text;
      if (!flag.startsWith("-")) break;
      if (COMMAND_SCRIPT_FLAGS.has(flag) || /c$/.test(flag)) {
        return { payload: tokens[j + 1].text, payloadIndex: j + 1 };
      }
    }
  }
  return null;
}

function parseCommandString(
  command: string,
  depth = 0,
): AgentCommandList | null {
  const tokens = tokenizeCommand(command);
  const items: AgentCommandItem[] = [];
  let segment: CommandToken[] = [];
  let op: AgentCommandOperator | undefined;

  for (const token of tokens) {
    if (token.op) {
      const item = parseCommandTokens(segment, op, depth);
      if (item) items.push(item);
      segment = [];
      op = token.op;
    } else {
      segment.push(token);
    }
  }

  const last = parseCommandTokens(segment, op, depth);
  if (last) items.push(last);

  return items.length > 0 ? { items } : null;
}

export function parseAgentCommandInput(
  input: unknown,
): AgentCommandList | null {
  const normalized = normalizeToolInput(input);
  if (!normalized) return null;
  const command = stringField(normalized, COMMAND_KEYS);
  if (!command) return null;
  return parseCommandString(command);
}


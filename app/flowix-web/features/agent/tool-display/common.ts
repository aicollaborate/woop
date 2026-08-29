export function stringField(
  input: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function normalizeToolInput(
  input: unknown,
): Record<string, unknown> | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    // Codex history stores CommandExecution.command as argv, while the live
    // tool stream supplies the equivalent shell command as a string. Feed
    // both through the streaming parser by normalizing argv at the boundary.
    if (Array.isArray(record.command)) {
      const command = record.command
        .filter((part): part is string => typeof part === "string")
        .map((part) => /[\s"';&|]/.test(part) ? JSON.stringify(part) : part)
        .join(" ")
        .trim();
      return command ? { ...record, command } : record;
    }
    return record;
  }
  if (Array.isArray(input)) return { items: input };
  if (typeof input === "string" && input.trim()) {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { command: input };
    }
    return { command: input };
  }
  return undefined;
}

export const COMMAND_KEYS = [
  "command_preview",
  "command",
  "command_text",
  "commandText",
  "cmd",
  "cmdline",
  "shell_command",
  "script",
] as const;

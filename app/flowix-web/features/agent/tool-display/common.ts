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
    return input as Record<string, unknown>;
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


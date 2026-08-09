/**
 * Tauri commands currently return errors as strings. Keep their diagnostic
 * code and any local filesystem context out of the mobile UI, while retaining
 * the actionable message supplied by the operating system or service.
 */
export function mobileErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  // The WebView can hot-reload before an iOS native rebuild finishes. In that
  // interval a newly added Tauri command is absent from the installed binary;
  // expose the required action rather than a Tauri implementation detail.
  if (/Command\s+mobile_delete_notebook\s+not found/i.test(raw)) {
    return '当前应用版本尚未包含“删除笔记本”功能，请更新应用后重试。';
  }

  const internalError = raw.match(/^[A-Z][A-Z0-9_]*(?:\s+[^:]+)?:\s*(.+)$/s);

  // e.g. `READ_NOTE_FAILED /private/.../note.md: No such file or directory`.
  // Only strip a leading all-caps internal code, so normal messages containing
  // a colon are left untouched.
  if (internalError) {
    return internalError[1];
  }
  return raw;
}

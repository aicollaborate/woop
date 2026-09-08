'use client';

import { useEffect } from 'react';
import { getAction } from '@/lib/shortcuts/registry';
import { getPlatform } from '@/lib/shortcuts/platform';
import { subscribe } from '@platform/tauri/event-bus';

const SELECT_ALL_EVENT = 'flowix://editor-select-all';

function selectFocusedNativeField(): boolean {
  const focused = document.activeElement;
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
    focused.select();
    return true;
  }
  return false;
}

/** Receives Cmd+A from the native macOS menu before it reaches the DOM. */
export function NativeSelectAllBridge() {
  useEffect(() => subscribe(SELECT_ALL_EVENT, () => {
    if (selectFocusedNativeField()) return;
    const action = getAction('editor.selectAll');
    if (!action) return;
    void action.run({ scope: 'editor', source: 'menu', platform: getPlatform() });
  }), []);

  return null;
}

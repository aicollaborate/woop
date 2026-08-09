import { describe, expect, it } from 'vitest';

import { mobileErrorMessage } from './error-message';

describe('mobileErrorMessage', () => {
  it('hides the internal code and local path from command errors', () => {
    expect(mobileErrorMessage(
      'READ_NOTE_FAILED /private/var/mobile/note.md: No such file or directory (os error 2)',
    )).toBe('No such file or directory (os error 2)');
  });

  it('keeps ordinary messages unchanged', () => {
    expect(mobileErrorMessage('网络暂不可用')).toBe('网络暂不可用');
  });

  it('explains when the running native app lacks the new delete command', () => {
    expect(mobileErrorMessage('Command mobile_delete_notebook not found')).toBe(
      '当前应用版本尚未包含“删除笔记本”功能，请更新应用后重试。',
    );
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_RECOVERY_KEY, readAttachmentRecovery, recordAttachmentRecovery } from './recovery';

describe('attachment recovery records', () => {
    beforeEach(() => localStorage.clear());

    it('deduplicates paths without deleting files', () => {
        expect(recordAttachmentRecovery(['/one'], 'memo-a')).toBe(true);
        recordAttachmentRecovery(['/one', '/two'], 'memo-a');
        expect(readAttachmentRecovery().map((entry) => entry.path)).toEqual(['/one', '/two']);
    });

    it('rejects malformed persisted state', () => {
        localStorage.setItem(ATTACHMENT_RECOVERY_KEY, '{');
        expect(readAttachmentRecovery()).toEqual([]);
        localStorage.setItem(ATTACHMENT_RECOVERY_KEY, JSON.stringify([null, { path: 42 }, { path: '/ok', memoId: 'memo', savedAt: 1 }]));
        expect(readAttachmentRecovery()).toEqual([{ path: '/ok', memoId: 'memo', savedAt: 1 }]);
    });

    it('bounds retained metadata', () => {
        recordAttachmentRecovery(Array.from({ length: 205 }, (_, index) => `/file-${index}`), 'memo');
        expect(readAttachmentRecovery()).toHaveLength(200);
    });
});

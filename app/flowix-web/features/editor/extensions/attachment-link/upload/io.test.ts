import { describe, expect, it } from 'vitest';
import { acquireUploadSlot, readFileBase64 } from './io';

describe('upload I/O limits', () => {
    it('limits parallel uploads and releases permits idempotently', () => {
        const first = acquireUploadSlot();
        const second = acquireUploadSlot();
        try {
            expect(() => acquireUploadSlot()).toThrow('ATTACHMENT_BUSY');
        } finally {
            first();
            first();
            second();
        }
        const third = acquireUploadSlot();
        third();
    });

    it('rejects cancelled reads before allocating a reader', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(readFileBase64(new File(['data'], 'file.txt'), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('produces Base64 without the data URL prefix', async () => {
        await expect(readFileBase64(new File(['abc'], 'file.txt'))).resolves.toBe('YWJj');
    });
});

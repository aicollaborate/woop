export const ATTACHMENT_RECOVERY_KEY = 'flowix:attachment-upload-recovery:v1';
export type AttachmentRecovery = { path: string; memoId: string; savedAt: number };

export function readAttachmentRecovery(): AttachmentRecovery[] {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(ATTACHMENT_RECOVERY_KEY) ?? '[]');
        if (!Array.isArray(value)) return [];
        return value.filter((entry): entry is AttachmentRecovery =>
            !!entry && typeof entry.path === 'string' && typeof entry.memoId === 'string'
            && typeof entry.savedAt === 'number' && Number.isFinite(entry.savedAt));
    } catch {
        return [];
    }
}

export function recordAttachmentRecovery(paths: string[], memoId?: string): boolean {
    try {
        const entries = new Map(readAttachmentRecovery().map((entry) => [entry.path, entry]));
        for (const path of paths) entries.set(path, { path, memoId: memoId ?? '', savedAt: Date.now() });
        localStorage.setItem(ATTACHMENT_RECOVERY_KEY, JSON.stringify(Array.from(entries.values()).slice(-200)));
        return true;
    } catch {
        return false;
    }
}

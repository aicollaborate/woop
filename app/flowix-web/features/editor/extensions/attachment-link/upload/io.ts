let activeUploads = 0;

export function acquireUploadSlot(): () => void {
    if (activeUploads >= 2) throw new Error('ATTACHMENT_BUSY');
    activeUploads += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        activeUploads -= 1;
    };
}

export function readFileBase64(file: Blob, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('Upload cancelled', 'AbortError'));
            return;
        }
        const reader = new FileReader();
        const cleanup = () => {
            signal?.removeEventListener('abort', abort);
            reader.onload = null;
            reader.onerror = null;
            reader.onabort = null;
        };
        const abort = () => {
            cleanup();
            reader.abort();
            reject(new DOMException('Upload cancelled', 'AbortError'));
        };
        reader.onload = () => {
            const result = String(reader.result ?? '');
            cleanup();
            resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
        };
        reader.onerror = () => {
            const error = reader.error ?? new Error('File read failed');
            cleanup();
            reject(error);
        };
        reader.onabort = abort;
        signal?.addEventListener('abort', abort, { once: true });
        try {
            reader.readAsDataURL(file);
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}

import { mobileClient } from '@platform/tauri/mobile-client';

const MOBILE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const MOBILE_ATTACHMENT_CHUNK_BYTES = 512 * 1024;

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      resolve(value.includes(',') ? value.slice(value.indexOf(',') + 1) : value);
    };
    reader.onerror = () => reject(reader.error ?? new Error('无法读取附件'));
    reader.readAsDataURL(blob);
  });
}

export function createTauriMobileAttachmentUploader(memoId: string) {
  return async ({ file, fileName }: { file: File; fileName: string }): Promise<string> => {
    if (file.size <= 0 || file.size > MOBILE_ATTACHMENT_MAX_BYTES) {
      throw new Error('单个附件不能超过 25 MB。');
    }
    const started = await mobileClient.attachments.beginUpload({
      fileName,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      memoId,
    });
    try {
      for (let offset = 0; offset < file.size; offset += MOBILE_ATTACHMENT_CHUNK_BYTES) {
        const chunk = file.slice(offset, Math.min(offset + MOBILE_ATTACHMENT_CHUNK_BYTES, file.size));
        await mobileClient.attachments.writeChunk({
          uploadId: started.uploadId,
          content: await readBlobAsBase64(chunk),
        });
      }
      return await mobileClient.attachments.finishUpload(started.uploadId);
    } catch (error) {
      void mobileClient.attachments.cancelUpload(started.uploadId);
      throw error;
    }
  };
}

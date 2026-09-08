import { toast } from '@/lib/toast';
import { translate, type I18nKey } from '@/lib/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';

export function reportUploadFailure(error: unknown): void {
    const message = String(error);
    const key: I18nKey = message.includes('ATTACHMENT_FILE_TOO_LARGE') ? 'editor.attachment.uploadFileTooLarge'
        : message.includes('TOO_LARGE') ? 'editor.attachment.uploadTooLarge'
        : message.includes('ATTACHMENT_BUSY') ? 'editor.attachment.uploadBusy'
        : message.includes('OWNER_REQUIRED') ? 'editor.attachment.uploadOwnerRequired'
        : 'editor.attachment.uploadFailed';
    toast.error(translate(useUserSettingsStore.getState().settings.language, key));
}

export function reportUninsertedAttachments(): void {
    toast.error(translate(useUserSettingsStore.getState().settings.language, 'editor.attachment.uploadUninserted'));
}

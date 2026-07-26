import { assetMarkdownUrl, decodeStorageKey } from '@features/editor/extensions/attachment-link/utils';
import type { JSONContent, MarkdownToken } from '@tiptap/core';

export function isAttachmentMarkdownUrl(url: string): boolean {
    return /^(asset:\/\/|https?:\/\/asset\.localhost\/)/i.test(url);
}

export function parseFileAttachmentMarkdown(token: MarkdownToken) {
    const url = typeof token.url === 'string' ? token.url : '';
    const title = typeof token.title === 'string' ? token.title : null;

    return {
        type: 'fileAttachment',
        attrs: {
            url,
            name: title ?? null,
            mimeType: null,
            size: 0,
            storageMode: 'attachment',
            storageKey: decodeStorageKey(url),
        },
    };
}

export function renderFileAttachmentMarkdown(node: JSONContent) {
    const { storageMode, storageKey, url, name } = node.attrs ?? {};
    const fileUrl = storageMode === 'attachment' && storageKey
        ? assetMarkdownUrl(String(storageKey))
        : url ?? '';
    return `[${name ?? ''}](${fileUrl})`;
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { EditorState, Plugin } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';
import { fileUploadPluginKey, runTrackedUpload, uploadState, uploadView } from './pending';
import { insertUploadContent } from './build-content';
import { recordAttachmentRecovery } from './recovery';
import type { StoredAsset } from './file-source';

vi.mock('./feedback', () => ({ reportUploadFailure: vi.fn(), reportUninsertedAttachments: vi.fn() }));
vi.mock('./recovery', () => ({ recordAttachmentRecovery: vi.fn() }));
vi.mock('./build-content', () => ({ buildUploadContent: vi.fn(() => [{ type: 'fileAttachment' }]), insertUploadContent: vi.fn() }));

const views: EditorView[] = [];
const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', toDOM: () => ['p', 0] }, text: {} } });
const asset: StoredAsset = { kind: 'file', url: 'asset:/file', name: 'file', mimeType: '', size: 1, storageKey: '/file' };

function fixture() {
    const state = EditorState.create({
        schema,
        doc: schema.node('doc', null, [schema.node('paragraph', null, schema.text('abcdef'))]),
        plugins: [new Plugin({ key: fileUploadPluginKey, state: uploadState, view: uploadView })],
    });
    const view = new EditorView(document.createElement('div'), { state });
    views.push(view);
    return view;
}

afterEach(() => {
    for (const view of views.splice(0)) if (!view.isDestroyed) view.destroy();
    vi.clearAllMocks();
});

describe('pending upload transactions', () => {
    it('maps the captured position through edits before upload completion', async () => {
        const view = fixture();
        let complete!: (assets: StoredAsset[]) => void;
        const upload = runTrackedUpload(view, () => new Promise((resolve) => { complete = resolve; }), 3, undefined, 'memo');
        view.dispatch(view.state.tr.insertText('xx', 1));
        complete([asset]);
        await upload;
        expect(insertUploadContent).toHaveBeenCalledWith(view, [{ type: 'fileAttachment' }], 5, undefined);
        expect(fileUploadPluginKey.getState(view.state)?.size).toBe(0);
    });

    it('cancels a deleted anchor and records any file already persisted', async () => {
        const view = fixture();
        let signal!: AbortSignal;
        let complete!: (assets: StoredAsset[]) => void;
        const upload = runTrackedUpload(view, (value) => {
            signal = value;
            return new Promise((resolve) => { complete = resolve; });
        }, 3, undefined, 'memo');
        view.dispatch(view.state.tr.delete(2, 5));
        expect(signal.aborted).toBe(true);
        complete([asset]);
        await upload;
        expect(insertUploadContent).not.toHaveBeenCalled();
        expect(recordAttachmentRecovery).toHaveBeenCalledWith(['/file'], 'memo');
    });

    it('aborts work when the editor is destroyed', async () => {
        const view = fixture();
        let signal!: AbortSignal;
        let complete!: (assets: StoredAsset[]) => void;
        const upload = runTrackedUpload(view, (value) => {
            signal = value;
            return new Promise((resolve) => { complete = resolve; });
        });
        view.destroy();
        expect(signal.aborted).toBe(true);
        complete([]);
        await upload;
        expect(insertUploadContent).not.toHaveBeenCalled();
    });

    it('does not start persistence for an invalid insertion position', async () => {
        const view = fixture();
        const load = vi.fn().mockResolvedValue([asset]);
        await runTrackedUpload(view, load, -1);
        expect(load).not.toHaveBeenCalled();
        expect(insertUploadContent).not.toHaveBeenCalled();
    });
});

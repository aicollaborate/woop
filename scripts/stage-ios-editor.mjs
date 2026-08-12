import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = resolve(root, '.build/ios-editor');
const destination = resolve(root, 'app/flowix-ios-native/Resources/EditorWebView');

if (!existsSync(source)) {
  throw new Error('Missing .build/ios-editor. Run npm run build:ios-editor first.');
}

mkdirSync(destination, { recursive: true });
for (const entry of [
  'editor-webview.html',
  'assets',
]) {
  rmSync(resolve(destination, entry), { recursive: true, force: true });
}
cpSync(resolve(source, 'editor-webview.html'), resolve(destination, 'editor-webview.html'));
cpSync(resolve(source, 'assets'), resolve(destination, 'assets'), { recursive: true });
console.log(`Staged iOS editor bundle in ${destination}`);

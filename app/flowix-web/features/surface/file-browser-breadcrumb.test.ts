import { describe, expect, it } from 'vitest';
import {
  resolveFileBrowserBreadcrumbItems,
  resolveFileBrowserBreadcrumbs,
} from './file-browser-breadcrumb';

describe('resolveFileBrowserBreadcrumbs', () => {
  it('uses the root directory name and relative file path', () => {
    expect(resolveFileBrowserBreadcrumbs(
      '/Users/rop/Desktop/vibe/flowix-main',
      '/Users/rop/Desktop/vibe/flowix-main/app/src/index.ts',
    )).toEqual(['flowix-main', 'app', 'src', 'index.ts']);
  });

  it('normalizes Windows separators', () => {
    expect(resolveFileBrowserBreadcrumbs(
      'C:\\work\\flowix-main',
      'C:\\work\\flowix-main\\app\\src\\index.ts',
    )).toEqual(['flowix-main', 'app', 'src', 'index.ts']);
  });

  it('shows only the root before a file is selected', () => {
    expect(resolveFileBrowserBreadcrumbs('/workspace/flowix-main', null))
      .toEqual(['flowix-main']);
  });

  it('keeps the exact folder path for each clickable breadcrumb', () => {
    expect(resolveFileBrowserBreadcrumbItems(
      '/workspace/flowix-main',
      '/workspace/flowix-main/app/src/index.ts',
    )).toEqual([
      { label: 'flowix-main', path: '/workspace/flowix-main', type: 'folder' },
      { label: 'app', path: '/workspace/flowix-main/app', type: 'folder' },
      { label: 'src', path: '/workspace/flowix-main/app/src', type: 'folder' },
      { label: 'index.ts', path: '/workspace/flowix-main/app/src/index.ts', type: 'file' },
    ]);
  });
});

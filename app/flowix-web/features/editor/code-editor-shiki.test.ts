import { Text, EditorState } from '@codemirror/state';
import type { Decoration, DecorationSet } from '@codemirror/view';
import { highlightingFor } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { describe, expect, it } from 'vitest';

import {
  buildShikiDecorationSet,
  shikiHighlighting,
  shikiLanguageIdForPath,
} from './code-editor-shiki';

interface CollectedMark {
  from: number;
  to: number;
  style?: string;
}

function collect(set: DecorationSet, from: number, to: number): CollectedMark[] {
  const marks: CollectedMark[] = [];
  set.between(from, to, (markFrom, markTo, value: Decoration) => {
    marks.push({
      from: markFrom,
      to: markTo,
      style: value.spec.attributes?.style,
    });
  });
  return marks;
}

function lineTokens(
  line: string,
  color = '#ffffff',
): { content: string; color: string }[] {
  return line ? [{ content: line, color }] : [];
}

describe('buildShikiDecorationSet', () => {
  it('maps each token across lines with newline offsets', () => {
    const doc = Text.of(['alpha', 'beta', 'gamma']);
    const lines = [lineTokens('alpha'), lineTokens('beta'), lineTokens('gamma')];

    const marks = collect(buildShikiDecorationSet(doc, lines), 0, doc.length);

    expect(marks).toEqual([
      { from: 0, to: 5, style: 'color: #ffffff' },
      { from: 6, to: 10, style: 'color: #ffffff' },
      { from: 11, to: 16, style: 'color: #ffffff' },
    ]);
  });

  it('skips empty tokens and tokens without a color', () => {
    const doc = Text.of(['', 'x']);
    const lines = [[{ content: '', color: '#fff' }], [{ content: 'x' }]];

    const marks = collect(buildShikiDecorationSet(doc, lines), 0, doc.length);

    expect(marks).toEqual([]);
  });

  it('stops cleanly when Shiki returns fewer lines than the doc', () => {
    const doc = Text.of(['a', 'b']);
    const lines = [lineTokens('a')];

    const marks = collect(buildShikiDecorationSet(doc, lines), 0, doc.length);

    expect(marks).toEqual([{ from: 0, to: 1, style: 'color: #ffffff' }]);
  });
});

describe('shikiLanguageIdForPath', () => {
  it('maps supported extensions to canonical Shiki language ids', () => {
    expect(shikiLanguageIdForPath('/x/note.md')).toBe('markdown');
    expect(shikiLanguageIdForPath('/x/file.ts')).toBe('typescript');
    expect(shikiLanguageIdForPath('/x/file.jsx')).toBe('jsx');
    expect(shikiLanguageIdForPath('/x/file.py')).toBe('python');
    expect(shikiLanguageIdForPath('/x/file.bash')).toBe('shellscript');
    expect(shikiLanguageIdForPath('/x/file.scss')).toBe('scss');
  });

  it('lowercases the extension', () => {
    expect(shikiLanguageIdForPath('/x/FILE.PY')).toBe('python');
  });

  it('returns null for cold or extensionless files', () => {
    expect(shikiLanguageIdForPath('/x/file.ex')).toBeNull();
    expect(shikiLanguageIdForPath('/x/file.txt')).toBeNull();
    expect(shikiLanguageIdForPath('/x/Makefile')).toBeNull();
  });
});

describe('shikiHighlighting', () => {
  it('suppresses basicSetup defaultHighlightStyle so Shiki is the sole color source', () => {
    const withFallbackOnly = EditorState.create({ extensions: [basicSetup] });
    expect(highlightingFor(withFallbackOnly, [tags.keyword])).not.toBeNull();

    const withShiki = EditorState.create({
      extensions: [basicSetup, shikiHighlighting('markdown')],
    });
    expect(highlightingFor(withShiki, [tags.keyword])).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import {
  createAgentThreadCardCommandPreview,
  createAgentThreadCardCommandList,
} from './agent-thread-card-command-renderer';
import type { AgentCommandItem } from '@features/agent/tool-display';

const POWERSHELL =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function findSpan(root: HTMLElement, className: string): HTMLSpanElement {
  const node = root.querySelector(`span.${className}`);
  if (!(node instanceof HTMLSpanElement)) {
    throw new Error(`expected <span class="${className}"> in ${root.outerHTML}`);
  }
  return node;
}

describe('agent-thread-card command renderer — path basename', () => {
  it('strips Windows path prefix and shows only the executable name', () => {
    const item: AgentCommandItem = {
      command: POWERSHELL,
      args: ['-Command', 'rg', '-n', '"PRAGMA foreign"'],
      env: [],
    };
    const list = createAgentThreadCardCommandList({ items: [item] });

    const name = findSpan(list, 'agent-thread-card__command-name');
    expect(name.textContent).toBe('powershell.exe');
  });

  it('strips POSIX path prefix and shows only the executable name', () => {
    const item: AgentCommandItem = {
      command: '/usr/local/bin/node',
      args: ['script.js'],
      env: [],
    };
    const list = createAgentThreadCardCommandList({ items: [item] });

    const name = findSpan(list, 'agent-thread-card__command-name');
    expect(name.textContent).toBe('node');
  });

  it('handles forward-slash paths', () => {
    const item: AgentCommandItem = {
      command: 'C:/Python311/python.exe',
      args: ['-V'],
      env: [],
    };
    const list = createAgentThreadCardCommandList({ items: [item] });

    const name = findSpan(list, 'agent-thread-card__command-name');
    expect(name.textContent).toBe('python.exe');
  });

  it('keeps short commands without path separators untouched', () => {
    const item: AgentCommandItem = {
      command: 'rg',
      args: ['-n', 'pattern'],
      env: [],
    };
    const list = createAgentThreadCardCommandList({ items: [item] });

    const name = findSpan(list, 'agent-thread-card__command-name');
    expect(name.textContent).toBe('rg');
  });

  it('keeps script.sh (no separator) untouched', () => {
    const item: AgentCommandItem = {
      command: 'script.sh',
      args: [],
      env: [],
    };
    const list = createAgentThreadCardCommandList({ items: [item] });

    const name = findSpan(list, 'agent-thread-card__command-name');
    expect(name.textContent).toBe('script.sh');
  });

  it('keeps title as the full original command for hover', () => {
    const item: AgentCommandItem = {
      command: POWERSHELL,
      args: ['-Command', 'rg'],
      env: [],
    };
    const list = createAgentThreadCardCommandList({ items: [item] });

    const name = findSpan(list, 'agent-thread-card__command-name');
    expect(name.textContent).toBe('powershell.exe');
    expect(name.title).toBe(POWERSHELL);
  });

  it('does not touch args when command is a path', () => {
    const args = ['-Command', 'rg', '-n', '"PRAGMA foreign"'];
    const item: AgentCommandItem = {
      command: POWERSHELL,
      args,
      env: [],
    };
    const list = createAgentThreadCardCommandList({ items: [item] });

    const argText = findSpan(list, 'agent-thread-card__command-args-inline');
    expect(argText.textContent).toBe(args.join(' '));
    expect(argText.title).toBe(args.join(' '));
  });

  it('can render an unbounded details list without compact markers', () => {
    const longArg = 'x'.repeat(1200);
    const items: AgentCommandItem[] = Array.from({ length: 7 }, (_, index) => ({
      command: 'echo',
      args: index === 6 ? [longArg] : [String(index)],
      env: [],
    }));
    const list = createAgentThreadCardCommandList({ items }, false, {
      maxItems: Number.POSITIVE_INFINITY,
      maxInlineArgs: Number.POSITIVE_INFINITY,
      truncateArgs: false,
    });

    expect(list.querySelectorAll('.agent-thread-card__command-item')).toHaveLength(7);
    expect(list.querySelector('.agent-thread-card__command-more')).toBeNull();
    expect(list.textContent).toContain(longArg);
  });
});

describe('agent-thread-card command renderer — compact preview', () => {
  it('renders the command and operators as one text run', () => {
    const preview = createAgentThreadCardCommandPreview({
      items: [
        { command: 'npm', args: ['run', 'build'], env: [] },
        { op: '&&', command: 'npm', args: ['test'], env: [] },
      ],
    });

    expect(preview.tagName).toBe('SPAN');
    expect(preview.textContent).toBe('npm run build && npm test');
    expect(preview.title).toBe(preview.textContent);
  });
});

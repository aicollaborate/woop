'use client';

import type { AgentTypeKey } from '@/types/agent';
import { AGENT_TYPES } from '@/lib/agent-types';
import type { PluginField } from '@platform/tauri/client';

export type PluginFieldValue = string | boolean;

export function isEmptyPluginFieldValue(
  value: PluginFieldValue | undefined,
  field: PluginField,
): boolean {
  if (field.type === 'checkbox') return value !== true;
  return String(value ?? '').trim().length === 0;
}

export function pluginFieldLabel(field: PluginField): string {
  return field.label || field.id;
}

export function PluginFieldControl({
  field,
  value,
  agentType,
  agentOptions,
  onChange,
  onAgentTypeChange,
}: {
  field: PluginField;
  value: PluginFieldValue | undefined;
  agentType: AgentTypeKey;
  agentOptions: typeof AGENT_TYPES;
  onChange: (value: PluginFieldValue) => void;
  onAgentTypeChange: (value: AgentTypeKey) => void;
}) {
  const id = `plugin-${field.id}`;
  const className = 'rounded-lg border border-[var(--border)] bg-[var(--background)] p-2 text-sm outline-none focus:border-[var(--brand)]';
  const options = field.options?.length
    ? field.options
    : agentOptions.map((item) => ({ value: item.key, label: item.name }));

  if (field.type === 'agent-select' || field.id === 'agentType') {
    return (
      <select
        id={id}
        value={agentType}
        onChange={(event) => onAgentTypeChange(event.target.value as AgentTypeKey)}
        className={className}
        required={field.required}
      >
        {options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
    );
  }

  if (field.type === 'select') {
    return (
      <select
        id={id}
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
        className={className}
        required={field.required}
      >
        <option value="">请选择</option>
        {field.options?.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
    );
  }

  if (field.type === 'checkbox') {
    return (
      <label className="flex items-center gap-2 text-sm text-[var(--foreground)]" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4 accent-[var(--brand)]"
        />
        <span>{field.placeholder || pluginFieldLabel(field)}</span>
      </label>
    );
  }

  if (field.type === 'number') {
    return (
      <input
        id={id}
        type="number"
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder || undefined}
        className={className}
        required={field.required}
      />
    );
  }

  if (field.type === 'text' || field.type === 'input') {
    return (
      <input
        id={id}
        type="text"
        value={String(value ?? '')}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder || undefined}
        className={className}
        required={field.required}
      />
    );
  }

  return (
    <textarea
      id={id}
      value={String(value ?? '')}
      onChange={(event) => onChange(event.target.value)}
      placeholder={field.placeholder || '请输入'}
      className="min-h-36 resize-y rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-sm outline-none focus:border-[var(--brand)]"
      required={field.required}
    />
  );
}

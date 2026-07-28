import type { PropertyFieldConfig } from '@/lib/constants';
import { canonicalizePropertyKey } from '@features/document/properties/property-key';
import { replaceVisibleFrontmatterProperties } from '@features/document/properties/frontmatter-model';
import { resolvePreset, type PropertyKind, type PropertyPreset } from '@features/document/properties/presets';

export type PropertyType = PropertyKind;

export interface PropertyRow {
  id: string;
  key: string;
  type: PropertyType;
  value: string;
  /** Optional preset binding. Drives the key-cell label/icon and the value
   *  cell's option list for Select / MultiSelect rows. Not written to YAML. */
  preset?: PropertyPreset;
  /** Custom 展示名 (UI-only, 不写入 YAML)。 命中预设时此字段被忽略 —
   *  trigger 走 preset.labelKey。 仅对未命中预设的自由 key 生效,
   *  非空时替换 raw key 的显示。 */
  customLabel?: string;
  /** 用户为 Select / MultiSelect 自定义的选项列表 (UI-only, 不写入 YAML)。
   *  命中预设时此字段被忽略, 走 preset.options; Custom 行读此字段。
   *  设计取舍: 选项不持久化, 关闭重开会丢, 用户接受即可 — 与 preset 同
   *  处理方式保持一致 ("类型" 等预设的 options 也是 UI-only)。 */
  options?: string[];
}


const URL_RE = /^https?:\/\/\S+$/i;
let rowIdSeq = 0;

export function createRowId(): string {
  rowIdSeq += 1;
  return `property-${rowIdSeq}`;
}

export function inferType(value: unknown): PropertyType {
  // 数组 → MultiSelect (旧 Tags 已合并到 MultiSelect)。
  if (Array.isArray(value)) return 'MultiSelect';
  if (typeof value === 'number') return 'Number';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Date';
    if (URL_RE.test(value)) return 'URL';
  }
  return 'Text';
}

export function stringifyValue(value: unknown, type: PropertyType): string {
  if (type === 'MultiSelect') {
    return Array.isArray(value) ? value.map((item) => String(item)).join(', ') : String(value ?? '');
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

export function rowsFromData(
  data: Record<string, unknown>,
  savedFieldsByKey: Map<string, PropertyFieldConfig> = new Map()
): PropertyRow[] {
  const hasCanonicalTags = Object.prototype.hasOwnProperty.call(data, 'tags');
  return Object.entries(data)
    .filter(([key]) => key.trim() !== 'key' && !(key === 'tag' && hasCanonicalTags))
    .map(([sourceKey, value]) => {
      const key = canonicalizePropertyKey(sourceKey);
      const preset = resolvePreset(key);
      const savedField = savedFieldsByKey.get(key);
      // 预设命中时优先用 preset.kind, 这样 'type' 不会被推断成 Text,
      // 'agent-role' 也能被识别成预设。 Custom (resolvePreset → null)
      // 走老路的 inferType, 保持向后兼容。
      const type: PropertyType = preset
        ? (preset.kind as PropertyType)
        : (savedField?.type ?? inferType(value));
      return {
        id: createRowId(),
        key,
        type,
        value: stringifyValue(value, type),
        preset: preset ?? undefined,
        customLabel: preset ? undefined : savedField?.name,
        options: preset ? undefined : savedField?.options,
      };
    });
}

export function convertRowValue(row: PropertyRow): unknown {
  const value = row.value.trim();
  switch (row.type) {
    case 'Number': {
      if (!value) return '';
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : value;
    }
    case 'MultiSelect':
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    case 'Select': {
      // 空 Select 表示 "未选择" — 写入时跳过整行, 不留 `key: ''`。
      if (!value) return null;
      return value;
    }
    case 'Date':
    case 'URL':
    case 'Text':
    default:
      return row.value;
  }
}

export function normalizeFieldOptions(type: PropertyType, options: string[] | undefined): string[] | undefined {
  if (type !== 'Select' && type !== 'MultiSelect') return undefined;
  const normalized = (options ?? [])
    .map((option) => option.trim())
    .filter(Boolean);
  return [...new Set(normalized)];
}

export function buildContentWithFrontmatter(content: string, rows: PropertyRow[]): string {
  return replaceVisibleFrontmatterProperties(
    content,
    rows.flatMap((row) => {
      const key = row.key.trim();
      if (!key) return [];
      const value = convertRowValue(row);
      return value === null ? [] : [{ key, value }];
    }),
  );
}

export function getDuplicateKeys(rows: PropertyRow[]): Set<string> {
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    const key = row.key.trim();
    if (!key) return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
}

export function coerceValueForType(value: string, nextType: PropertyType): string {
  if (nextType === 'Date') {
    const match = value.match(/\d{4}-\d{2}-\d{2}/);
    return match?.[0] ?? '';
  }
  return value;
}

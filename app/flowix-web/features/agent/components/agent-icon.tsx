import type { CSSProperties } from 'react';
import { getAgentType } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import { cn } from '@/lib/utils';

/**
 * Agent icons that are intentionally rendered with the current theme color.
 * Other agent icons keep their original brand colors and continue to use img.
 */
export const THEME_ADAPTIVE_AGENT_ICON_KEYS = new Set<AgentTypeKey>([
  'deepseek-harness',
  'opencode',
  'hermes',
]);

export function isThemeAdaptiveAgentIcon(typeKey: AgentTypeKey): boolean {
  return THEME_ADAPTIVE_AGENT_ICON_KEYS.has(typeKey);
}

export interface AgentIconProps {
  typeKey: AgentTypeKey;
  alt?: string;
  className?: string;
  style?: CSSProperties;
  draggable?: boolean;
}

/**
 * Shared agent icon renderer.
 *
 * SVGs loaded through <img> cannot inherit CSS currentColor from the host
 * document. The monochrome agent icons therefore use the SVG as a CSS
 * mask, while the remaining branded icons keep their original SVG colors.
 */
export function AgentIcon({
  typeKey,
  alt = '',
  className,
  style,
  draggable = false,
}: AgentIconProps) {
  const type = getAgentType(typeKey);

  if (!isThemeAdaptiveAgentIcon(typeKey)) {
    return (
      <img
        src={type.icon}
        alt={alt}
        className={className}
        style={style}
        draggable={draggable}
      />
    );
  }

  const maskStyle = {
    ...style,
    '--agent-icon-src': `url("${type.icon}")`,
  } as CSSProperties & { '--agent-icon-src': string };

  return (
    <span
      className={cn('agent-icon agent-icon--masked', className)}
      style={maskStyle}
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
    />
  );
}

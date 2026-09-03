'use client';

import type { CSSProperties, ReactNode } from 'react';
import { isMac } from '@features/shortcuts';

interface ThirdColumnTitlebarShellProps {
  isWindows: boolean;
  showTrafficLightSpacer?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/** Shared frame for the third-column document and Agent titlebars. */
export function ThirdColumnTitlebarShell({
  isWindows,
  showTrafficLightSpacer = false,
  className = '',
  style,
  children,
}: ThirdColumnTitlebarShellProps) {
  return (
    <div
      data-tauri-drag-region
      className={`z-[50] flex shrink-0 select-none items-center pl-2 ${
        isWindows ? 'h-9 pr-[126px]' : 'h-12'
      } ${className}`}
      style={style}
    >
      {isMac() && showTrafficLightSpacer && (
        <div aria-hidden="true" className="h-full w-[80px] shrink-0" />
      )}
      {children}
    </div>
  );
}

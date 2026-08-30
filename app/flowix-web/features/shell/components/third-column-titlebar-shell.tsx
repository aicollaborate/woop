'use client';

import type { CSSProperties, ReactNode } from 'react';
import { isMac } from '@features/shortcuts';

interface ThirdColumnTitlebarShellProps {
  isWindows: boolean;
  showTrafficLightSpacer?: boolean;
  dataTabWindowHeader?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/** Shared frame for the third-column document and Agent titlebars. */
export function ThirdColumnTitlebarShell({
  isWindows,
  showTrafficLightSpacer = false,
  dataTabWindowHeader = false,
  className = '',
  style,
  children,
}: ThirdColumnTitlebarShellProps) {
  return (
    <div
      data-tauri-drag-region
      data-tab-window-header={dataTabWindowHeader ? '' : undefined}
      className={`z-[50] flex shrink-0 select-none items-center pl-4 ${
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

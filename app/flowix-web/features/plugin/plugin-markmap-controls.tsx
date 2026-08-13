'use client';

import {
  ArrowSquareOutIcon,
  ArrowsInIcon,
  CornersInIcon,
  CornersOutIcon,
  MinusIcon,
  PlusIcon,
} from '@phosphor-icons/react';
import { Tooltip } from '@shared/ui/tooltip';

const controlButtonClass = 'plugin-markmap-controls__button';

export function PluginMarkmapControls({
  fullscreen,
  onFit,
  onZoomIn,
  onZoomOut,
  onToggleFullscreen,
  onOpenArtifact,
}: {
  fullscreen: boolean;
  onFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onToggleFullscreen: () => void;
  onOpenArtifact?: () => void;
}) {
  return (
    <div className="plugin-markmap-controls" role="toolbar" aria-label="思维导图操作控件">
      <Tooltip content="缩小">
        <button type="button" className={controlButtonClass} onClick={onZoomOut} aria-label="缩小">
          <MinusIcon size={16} weight="bold" aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip content="适配画布">
        <button type="button" className={controlButtonClass} onClick={onFit} aria-label="适配画布">
          <ArrowsInIcon size={16} weight="bold" aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip content="放大">
        <button type="button" className={controlButtonClass} onClick={onZoomIn} aria-label="放大">
          <PlusIcon size={16} weight="bold" aria-hidden="true" />
        </button>
      </Tooltip>
      <span className="plugin-markmap-controls__divider" aria-hidden="true" />
      {onOpenArtifact && (
        <Tooltip content="打开产物">
          <button type="button" className={controlButtonClass} onClick={onOpenArtifact} aria-label="打开产物">
            <ArrowSquareOutIcon size={16} weight="bold" aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      <Tooltip content={fullscreen ? '退出全屏' : '全屏'}>
        <button
          type="button"
          className={controlButtonClass}
          onClick={onToggleFullscreen}
          aria-label={fullscreen ? '退出全屏' : '全屏'}
        >
          {fullscreen
            ? <CornersInIcon size={16} weight="bold" aria-hidden="true" />
            : <CornersOutIcon size={16} weight="bold" aria-hidden="true" />}
        </button>
      </Tooltip>
    </div>
  );
}

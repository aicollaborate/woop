'use client';

import { useEffect, useState } from 'react';

import { boot } from '@platform/tauri/client';

let cachedExperimentalMode: boolean | undefined;
let pendingExperimentalMode: Promise<boolean> | null = null;

function loadExperimentalMode(): Promise<boolean> {
  if (cachedExperimentalMode !== undefined) {
    return Promise.resolve(cachedExperimentalMode);
  }
  if (!pendingExperimentalMode) {
    pendingExperimentalMode = boot.getFeatures()
      .then((features) => features.experimental === true)
      .catch(() => false)
      .then((experimental) => {
        cachedExperimentalMode = experimental;
        return experimental;
      });
  }
  return pendingExperimentalMode;
}

export function useExperimentalMode(): boolean {
  const [experimental, setExperimental] = useState(cachedExperimentalMode ?? false);

  useEffect(() => {
    let active = true;
    void loadExperimentalMode().then((next) => {
      if (active) setExperimental(next);
    });
    return () => {
      active = false;
    };
  }, []);

  return experimental;
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { MODEL_REGISTRY_UPDATED_EVENT } from '@/lib/flyreq-models';
import {
  isPromptOptimizeEnabled,
  PROMPT_OPTIMIZE_SETTING_EVENT,
  setPromptOptimizeEnabled,
} from '@/lib/settings-storage';

export function usePromptOptimizeSetting() {
  const [enabled, setEnabledState] = useState(false);

  const refresh = useCallback(() => {
    setEnabledState(isPromptOptimizeEnabled());
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) refresh();
    });
    window.addEventListener(PROMPT_OPTIMIZE_SETTING_EVENT, refresh);
    window.addEventListener(MODEL_REGISTRY_UPDATED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(PROMPT_OPTIMIZE_SETTING_EVENT, refresh);
      window.removeEventListener(MODEL_REGISTRY_UPDATED_EVENT, refresh);
    };
  }, [refresh]);

  const setEnabled = useCallback((nextEnabled: boolean) => {
    const applied = setPromptOptimizeEnabled(nextEnabled);
    refresh();
    return applied;
  }, [refresh]);

  return { enabled, setEnabled, refresh };
}

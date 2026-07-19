'use client';

import { useEffect, useState } from 'react';
import { MODEL_REGISTRY_STORAGE_KEY, MODEL_REGISTRY_UPDATED_EVENT } from '@/lib/flyreq-models';

export function useModelRegistryRefresh(): number {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const refresh = () => setVersion(current => current + 1);
    const handleStorage = (event: StorageEvent) => {
      if (event.key === MODEL_REGISTRY_STORAGE_KEY) {
        refresh();
      }
    };

    window.addEventListener(MODEL_REGISTRY_UPDATED_EVENT, refresh);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(MODEL_REGISTRY_UPDATED_EVENT, refresh);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  return version;
}

import { useEffect, useState } from 'react';
import { flyreqTaskSocket } from '@/lib/flyreq-task-socket';
import type { FlyreqQueueStatus } from '@/lib/flyreq-task-client';

export function useQueueStatus() {
  const [queueStatus, setQueueStatus] = useState<FlyreqQueueStatus | null>(null);

  useEffect(() => {
    const unsubscribe = flyreqTaskSocket.subscribeQueue(stats => setQueueStatus(stats));
    return () => {
      unsubscribe();
    };
  }, []);

  return queueStatus;
}

import { ackFlyreqTask } from '@/lib/flyreq-task-client';

const PENDING_SERVER_TASK_ACKS_KEY = 'flyreq-pending-server-task-acks';
const DEFAULT_ACK_AUTO_FLUSH_INTERVAL_MS = 60 * 1000;

export interface PendingServerTaskAckAutoFlushOptions {
  intervalMs?: number;
  flushImmediately?: boolean;
  onAcked?: (taskIds: string[]) => void | Promise<void>;
}

export interface PendingServerTaskAckFlushOptions {
  onAcked?: (taskIds: string[]) => void | Promise<void>;
}

function uniqueTaskIds(taskIds: string[]): string[] {
  return [...new Set(taskIds.map(id => id.trim()).filter(Boolean))];
}

export function loadPendingServerTaskAcks(): string[] {
  if (typeof window === 'undefined') return [];

  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_SERVER_TASK_ACKS_KEY) || '[]');
    return Array.isArray(parsed)
      ? uniqueTaskIds(parsed.filter((item): item is string => typeof item === 'string'))
      : [];
  } catch {
    return [];
  }
}

function savePendingServerTaskAcks(taskIds: string[]): boolean {
  if (typeof window === 'undefined') return true;

  const pending = uniqueTaskIds(taskIds);
  try {
    if (pending.length === 0) {
      localStorage.removeItem(PENDING_SERVER_TASK_ACKS_KEY);
    } else {
      localStorage.setItem(PENDING_SERVER_TASK_ACKS_KEY, JSON.stringify(pending));
    }
    return true;
  } catch {
    return false;
  }
}

function rememberPendingServerTaskAck(taskId: string): boolean {
  return savePendingServerTaskAcks([...loadPendingServerTaskAcks(), taskId]);
}

function forgetPendingServerTaskAck(taskId: string): boolean {
  return savePendingServerTaskAcks(loadPendingServerTaskAcks().filter(id => id !== taskId));
}

export async function ackServerTaskWithRetry(taskId: string): Promise<boolean> {
  try {
    await ackFlyreqTask(taskId);
    forgetPendingServerTaskAck(taskId);
    return true;
  } catch {
    rememberPendingServerTaskAck(taskId);
    return false;
  }
}

export async function flushPendingServerTaskAcks(options: PendingServerTaskAckFlushOptions = {}): Promise<void> {
  const pending = loadPendingServerTaskAcks();
  if (pending.length === 0) return;

  const remaining: string[] = [];
  const acked: string[] = [];
  for (const taskId of pending) {
    try {
      await ackFlyreqTask(taskId);
      acked.push(taskId);
    } catch {
      remaining.push(taskId);
    }
  }
  savePendingServerTaskAcks(remaining);
  if (acked.length > 0) {
    await options.onAcked?.(acked);
  }
}

export function startPendingServerTaskAckAutoFlush(options: PendingServerTaskAckAutoFlushOptions = {}): () => void {
  if (typeof window === 'undefined') return () => undefined;

  let stopped = false;
  let inFlight = false;
  const intervalMs = Math.max(5000, Math.trunc(options.intervalMs ?? DEFAULT_ACK_AUTO_FLUSH_INTERVAL_MS));

  const run = () => {
    if (stopped || inFlight) return;
    inFlight = true;
    void flushPendingServerTaskAcks({ onAcked: options.onAcked }).finally(() => {
      inFlight = false;
    });
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') run();
  };

  if (options.flushImmediately !== false) run();
  window.addEventListener('online', run);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  const timer = window.setInterval(run, intervalMs);

  return () => {
    stopped = true;
    window.removeEventListener('online', run);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.clearInterval(timer);
  };
}

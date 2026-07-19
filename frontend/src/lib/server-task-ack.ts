import { ackFlyreqTask, cancelFlyreqTask, FlyreqTaskError } from '@/lib/flyreq-task-client';

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

export interface PendingServerTaskAck {
  taskId: string;
  readToken?: string;
  operation?: 'ack' | 'cancel';
}

function uniqueTaskAcks(items: PendingServerTaskAck[]): PendingServerTaskAck[] {
  const byId = new Map<string, PendingServerTaskAck>();
  for (const item of items) {
    const taskId = item.taskId.trim();
    if (!taskId) continue;
    byId.set(taskId, { taskId, readToken: item.readToken, operation: item.operation === 'cancel' ? 'cancel' : 'ack' });
  }
  return [...byId.values()];
}

export function loadPendingServerTaskAcks(): PendingServerTaskAck[] {
  if (typeof window === 'undefined') return [];

  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_SERVER_TASK_ACKS_KEY) || '[]');
    return Array.isArray(parsed)
      ? uniqueTaskAcks(parsed.map(item => {
        if (typeof item === 'string') return { taskId: item };
        if (item && typeof item === 'object' && typeof item.taskId === 'string') {
          return {
            taskId: item.taskId,
            readToken: typeof item.readToken === 'string' ? item.readToken : undefined,
            operation: item.operation === 'cancel' ? 'cancel' : 'ack',
          };
        }
        return { taskId: '' };
      }))
      : [];
  } catch {
    return [];
  }
}

function savePendingServerTaskAcks(items: PendingServerTaskAck[]): boolean {
  if (typeof window === 'undefined') return true;

  const pending = uniqueTaskAcks(items);
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

function rememberPendingServerTaskAck(taskId: string, readToken?: string, operation: PendingServerTaskAck['operation'] = 'ack'): boolean {
  return savePendingServerTaskAcks([...loadPendingServerTaskAcks(), { taskId, readToken, operation }]);
}

function forgetPendingServerTaskAck(taskId: string): boolean {
  return savePendingServerTaskAcks(loadPendingServerTaskAcks().filter(item => item.taskId !== taskId));
}

function isSettledAckError(error: unknown): boolean {
  if (!(error instanceof FlyreqTaskError)) return false;
  if (error.statusCode === 404) return true;
  if (error.code === 'TASK_NOT_FOUND' || error.code === 'TASK_EXPIRED') return true;
  if (error.code === 'INVALID_TASK_TOKEN') return true;
  return false;
}

export async function ackServerTaskWithRetry(taskId: string, readToken?: string): Promise<boolean> {
  try {
    await ackFlyreqTask(taskId, readToken);
    forgetPendingServerTaskAck(taskId);
    return true;
  } catch (error) {
    if (isSettledAckError(error)) {
      forgetPendingServerTaskAck(taskId);
      return error instanceof FlyreqTaskError && error.code !== 'INVALID_TASK_TOKEN';
    }
    rememberPendingServerTaskAck(taskId, readToken, 'ack');
    return false;
  }
}

export async function cancelServerTaskWithRetry(taskId: string, readToken?: string): Promise<boolean> {
  try {
    await cancelFlyreqTask(taskId, readToken);
    forgetPendingServerTaskAck(taskId);
    return true;
  } catch (error) {
    if (isSettledAckError(error)) {
      forgetPendingServerTaskAck(taskId);
      return error instanceof FlyreqTaskError && error.code !== 'INVALID_TASK_TOKEN';
    }
    rememberPendingServerTaskAck(taskId, readToken, 'cancel');
    return false;
  }
}

export async function flushPendingServerTaskAcks(options: PendingServerTaskAckFlushOptions = {}): Promise<void> {
  const pending = loadPendingServerTaskAcks();
  if (pending.length === 0) return;

  const remaining: PendingServerTaskAck[] = [];
  const acked: string[] = [];
  for (const item of pending) {
    try {
      if (item.operation === 'cancel') {
        await cancelFlyreqTask(item.taskId, item.readToken);
      } else {
        await ackFlyreqTask(item.taskId, item.readToken);
      }
      acked.push(item.taskId);
    } catch (error) {
      if (isSettledAckError(error)) {
        if (error instanceof FlyreqTaskError && error.code !== 'INVALID_TASK_TOKEN') {
          acked.push(item.taskId);
        }
      } else {
        remaining.push(item);
      }
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

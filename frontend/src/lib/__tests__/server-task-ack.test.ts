import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ackFlyreqTask, cancelFlyreqTask, FlyreqTaskError } from '@/lib/flyreq-task-client';
import {
  ackServerTaskWithRetry,
  cancelServerTaskWithRetry,
  flushPendingServerTaskAcks,
  loadPendingServerTaskAcks,
  startPendingServerTaskAckAutoFlush,
} from '@/lib/server-task-ack';

vi.mock('@/lib/flyreq-task-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/flyreq-task-client')>();
  return {
    ...actual,
    ackFlyreqTask: vi.fn(),
    cancelFlyreqTask: vi.fn(),
  };
});

const mockedAckFlyreqTask = vi.mocked(ackFlyreqTask);
const mockedCancelFlyreqTask = vi.mocked(cancelFlyreqTask);

describe('server task ack retry queue', () => {
  beforeEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    mockedAckFlyreqTask.mockReset();
    mockedCancelFlyreqTask.mockReset();
  });

  it('records failed acknowledgements and removes them after a later successful flush', async () => {
    mockedAckFlyreqTask.mockRejectedValueOnce(new Error('network down'));

    await expect(ackServerTaskWithRetry('task-1', 'token-1')).resolves.toBe(false);

    expect(loadPendingServerTaskAcks()).toEqual([{ taskId: 'task-1', readToken: 'token-1', operation: 'ack' }]);

    mockedAckFlyreqTask.mockResolvedValueOnce(undefined);
    await flushPendingServerTaskAcks();

    expect(mockedAckFlyreqTask).toHaveBeenLastCalledWith('task-1', 'token-1');
    expect(loadPendingServerTaskAcks()).toEqual([]);
  });

  it('reports task ids that were acknowledged by a later flush', async () => {
    mockedAckFlyreqTask.mockRejectedValueOnce(new Error('network down'));
    await ackServerTaskWithRetry('task-1');

    const onAcked = vi.fn();
    mockedAckFlyreqTask.mockResolvedValueOnce(undefined);
    await flushPendingServerTaskAcks({ onAcked });

    expect(onAcked).toHaveBeenCalledWith(['task-1']);
    expect(loadPendingServerTaskAcks()).toEqual([]);
  });

  it('treats already expired pending acknowledgements as settled instead of retrying forever', async () => {
    mockedAckFlyreqTask.mockRejectedValueOnce(new Error('network down'));
    await ackServerTaskWithRetry('task-1', 'token-1');

    const onAcked = vi.fn();
    mockedAckFlyreqTask.mockRejectedValueOnce(new FlyreqTaskError('expired', 404, 'TASK_EXPIRED'));
    await flushPendingServerTaskAcks({ onAcked });

    expect(onAcked).toHaveBeenCalledWith(['task-1']);
    expect(loadPendingServerTaskAcks()).toEqual([]);
  });

  it('forgets permanently invalid pending acknowledgements without reporting them as acked', async () => {
    mockedAckFlyreqTask.mockRejectedValueOnce(new Error('network down'));
    await ackServerTaskWithRetry('task-1', 'bad-token');

    const onAcked = vi.fn();
    mockedAckFlyreqTask.mockRejectedValueOnce(new FlyreqTaskError('bad token', 403, 'INVALID_TASK_TOKEN'));
    await flushPendingServerTaskAcks({ onAcked });

    expect(onAcked).not.toHaveBeenCalled();
    expect(loadPendingServerTaskAcks()).toEqual([]);
  });

  it('does not queue invalid acknowledgements when the server rejects the read token', async () => {
    mockedAckFlyreqTask.mockRejectedValueOnce(new FlyreqTaskError('bad token', 403, 'INVALID_TASK_TOKEN'));

    await expect(ackServerTaskWithRetry('task-1', 'bad-token')).resolves.toBe(false);

    expect(loadPendingServerTaskAcks()).toEqual([]);
  });

  it('cancels a server task with its read token', async () => {
    mockedCancelFlyreqTask.mockResolvedValueOnce(undefined);

    await expect(cancelServerTaskWithRetry('task-1', 'token-1')).resolves.toBe(true);

    expect(mockedCancelFlyreqTask).toHaveBeenCalledWith('task-1', 'token-1');
    expect(loadPendingServerTaskAcks()).toEqual([]);
  });

  it('records failed cancellations for later cancel cleanup', async () => {
    mockedCancelFlyreqTask.mockRejectedValueOnce(new Error('network down'));

    await expect(cancelServerTaskWithRetry('task-1', 'token-1')).resolves.toBe(false);

    expect(loadPendingServerTaskAcks()).toEqual([{ taskId: 'task-1', readToken: 'token-1', operation: 'cancel' }]);
  });

  it('retries failed cancellations as cancellations when the browser comes back online', async () => {
    mockedCancelFlyreqTask.mockRejectedValueOnce(new Error('network down'));
    await cancelServerTaskWithRetry('task-1', 'token-1');

    mockedCancelFlyreqTask.mockResolvedValueOnce(undefined);
    await flushPendingServerTaskAcks();

    expect(mockedCancelFlyreqTask).toHaveBeenLastCalledWith('task-1', 'token-1');
    expect(mockedAckFlyreqTask).not.toHaveBeenCalled();
    expect(loadPendingServerTaskAcks()).toEqual([]);
  });

  it('flushes pending acknowledgements again when the browser comes back online', async () => {
    mockedAckFlyreqTask.mockRejectedValueOnce(new Error('network down'));
    await ackServerTaskWithRetry('task-1');
    mockedAckFlyreqTask.mockResolvedValueOnce(undefined);

    const stop = startPendingServerTaskAckAutoFlush({ flushImmediately: false, intervalMs: 60000 });
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(loadPendingServerTaskAcks()).toEqual([]));
    stop();
  });
});

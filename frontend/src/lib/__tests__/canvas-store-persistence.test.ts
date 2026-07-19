import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const localForageSetItemMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
const deleteStoredImagesMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
const collectImageStorageKeysMock = vi.hoisted(() => (value: unknown, keys = new Set<string>()) => {
  if (!value || typeof value !== 'object') return keys;
  if ('storageKey' in value && typeof value.storageKey === 'string' && value.storageKey.startsWith('image:')) {
    keys.add(value.storageKey);
  }
  Object.values(value).forEach(item => {
    if (Array.isArray(item)) {
      item.forEach(child => collectImageStorageKeysMock(child, keys));
    } else {
      collectImageStorageKeysMock(item, keys);
    }
  });
  return keys;
});

vi.mock('@/components/canvas/lib/localforage-storage', () => ({
  localForageStorage: {
    getItem: vi.fn(async () => null),
    setItem: localForageSetItemMock,
    removeItem: vi.fn(async () => undefined),
  },
}));

vi.mock('@/components/canvas/lib/image-storage', () => ({
  collectImageStorageKeys: collectImageStorageKeysMock,
  deleteStoredImages: deleteStoredImagesMock,
}));

import { flushCanvasStorePersistence, useCanvasStore } from '@/components/canvas/stores/use-canvas-store';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const canvasEditorSource = fs.readFileSync(
  path.resolve(testDir, '../../components/canvas/CanvasEditor.tsx'),
  'utf8',
);

describe('canvas store persistence flushing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localForageSetItemMock.mockResolvedValue(undefined);
    deleteStoredImagesMock.mockResolvedValue(undefined);
    useCanvasStore.setState({ hydrated: true, projects: [] });
  });

  it('flushes pending debounced project writes', async () => {
    useCanvasStore.getState().createProject('闭环画布');

    await flushCanvasStorePersistence();

    expect(localForageSetItemMock).toHaveBeenCalledWith(
      'flyreq-image:canvas_store',
      expect.stringContaining('闭环画布'),
    );
  });

  it('propagates persistence failures so callers can keep server tasks unacked', async () => {
    localForageSetItemMock.mockRejectedValueOnce(new Error('idb unavailable'));
    useCanvasStore.getState().createProject('失败画布');

    await expect(flushCanvasStorePersistence()).rejects.toThrow('idb unavailable');
  });

  it('deletes image blobs that become unused when canvas projects are removed', async () => {
    useCanvasStore.setState({
      hydrated: true,
      projects: [
        {
          id: 'keep',
          title: 'keep',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          nodes: [{ id: 'keep-node', type: 'image' as never, title: 'keep', position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { storageKey: 'image:shared' } }],
          connections: [],
          backgroundMode: 'lines',
          showImageInfo: false,
          viewport: { x: 0, y: 0, k: 1 },
        },
        {
          id: 'remove',
          title: 'remove',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          nodes: [
            { id: 'remove-node', type: 'image' as never, title: 'remove', position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { storageKey: 'image:orphan' } },
            { id: 'shared-node', type: 'image' as never, title: 'shared', position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { storageKey: 'image:shared' } },
          ],
          connections: [],
          backgroundMode: 'lines',
          showImageInfo: false,
          viewport: { x: 0, y: 0, k: 1 },
        },
      ],
    });

    useCanvasStore.getState().deleteProjects(['remove']);
    await Promise.resolve();

    expect(deleteStoredImagesMock).toHaveBeenCalledWith(['image:orphan']);
  });

  it('flushes newly created generation nodes before submitting server tasks', () => {
    const commitIndex = canvasEditorSource.indexOf('commitCanvasSnapshot({ ...baseSnapshot, nodes: nextNodes, connections: nextConnections });');
    const flushIndex = canvasEditorSource.indexOf('await flushCanvasStorePersistence();', commitIndex);
    const submitIndex = canvasEditorSource.indexOf('void startNodeGeneration', commitIndex);

    expect(commitIndex).toBeGreaterThan(-1);
    expect(flushIndex).toBeGreaterThan(commitIndex);
    expect(flushIndex).toBeLessThan(submitIndex);
  });

  it('flushes generation task ids before polling server tasks', () => {
    const taskIdPatchIndex = canvasEditorSource.indexOf('generationTaskId: taskAccess.taskId');
    const flushIndex = canvasEditorSource.indexOf('await flushCanvasStorePersistence();', taskIdPatchIndex);
    const pollIndex = canvasEditorSource.indexOf('const images = await pollNodeTask', taskIdPatchIndex);

    expect(taskIdPatchIndex).toBeGreaterThan(-1);
    expect(flushIndex).toBeGreaterThan(taskIdPatchIndex);
    expect(flushIndex).toBeLessThan(pollIndex);
  });

  it('keeps the generated task id visible when task-id persistence fails', () => {
    expect(canvasEditorSource).toContain('let createdTaskId: string | null = null;');
    expect(canvasEditorSource).toContain('createdTaskId = taskAccess.taskId;');
    expect(canvasEditorSource).toContain('createdTaskId ? `${message}（任务 ID：${createdTaskId}）` : message');
  });

  it('queues abandoned canvas server tasks for cancel instead of dropping them on abort', () => {
    const createdTaskIndex = canvasEditorSource.indexOf('createdTaskId = taskAccess.taskId;');
    const abortCheckIndex = canvasEditorSource.indexOf('controller.signal.aborted', createdTaskIndex);
    const abandonCancelIndex = canvasEditorSource.indexOf('queueAbandonedServerTaskCancel();', createdTaskIndex);

    expect(createdTaskIndex).toBeGreaterThan(-1);
    expect(abortCheckIndex).toBeGreaterThan(createdTaskIndex);
    expect(abandonCancelIndex).toBeGreaterThan(abortCheckIndex);
  });

  it('does not let a stale canvas generation controller delete a newer active controller', () => {
    const finallyIndex = canvasEditorSource.indexOf('} finally {', canvasEditorSource.indexOf('const taskAccess = await submitNodeGeneration'));
    const guardedDeleteIndex = canvasEditorSource.indexOf('if (activeGenerationsRef.current.get(nodeId) === controller)', finallyIndex);
    const rawDeleteIndex = canvasEditorSource.indexOf('activeGenerationsRef.current.delete(nodeId);', finallyIndex);

    expect(finallyIndex).toBeGreaterThan(-1);
    expect(guardedDeleteIndex).toBeGreaterThan(finallyIndex);
    expect(rawDeleteIndex).toBeGreaterThan(guardedDeleteIndex);
  });

  it('queues recovered canvas server tasks for cancel when recovery is abandoned', () => {
    const recoveryIndex = canvasEditorSource.indexOf('const recoveryKey = `${node.id}:${taskId}`;');
    const queueCancelIndex = canvasEditorSource.indexOf('const queueRecoveredServerTaskCancel = () => {', recoveryIndex);
    const abortCheckIndex = canvasEditorSource.indexOf('if (controller.signal.aborted)', queueCancelIndex);
    const recoverCancelCallIndex = canvasEditorSource.indexOf('queueRecoveredServerTaskCancel();', abortCheckIndex);

    expect(recoveryIndex).toBeGreaterThan(-1);
    expect(queueCancelIndex).toBeGreaterThan(recoveryIndex);
    expect(abortCheckIndex).toBeGreaterThan(queueCancelIndex);
    expect(recoverCancelCallIndex).toBeGreaterThan(abortCheckIndex);
  });

  it('does not let a stale recovered canvas controller delete a newer active controller', () => {
    const recoveryIndex = canvasEditorSource.indexOf('const recoveryKey = `${node.id}:${taskId}`;');
    const finallyIndex = canvasEditorSource.indexOf('} finally {', recoveryIndex);
    const guardedDeleteIndex = canvasEditorSource.indexOf('if (activeGenerationsRef.current.get(node.id) === controller)', finallyIndex);
    const rawDeleteIndex = canvasEditorSource.indexOf('activeGenerationsRef.current.delete(node.id);', finallyIndex);

    expect(recoveryIndex).toBeGreaterThan(-1);
    expect(finallyIndex).toBeGreaterThan(recoveryIndex);
    expect(guardedDeleteIndex).toBeGreaterThan(finallyIndex);
    expect(rawDeleteIndex).toBeGreaterThan(guardedDeleteIndex);
  });

  it('uses the first recovered poll result instead of re-downloading completed canvas results', () => {
    const recoveryIndex = canvasEditorSource.indexOf('仍在进行中 → 继续轮询');
    const pollIndex = canvasEditorSource.indexOf('const images = await pollNodeTask', recoveryIndex);
    const persistIndex = canvasEditorSource.indexOf('await persistGeneratedImageNode(node.id, image', pollIndex);
    const finalCheckIndex = canvasEditorSource.indexOf('const finalResult = await checkExistingTask', recoveryIndex);

    expect(recoveryIndex).toBeGreaterThan(-1);
    expect(pollIndex).toBeGreaterThan(recoveryIndex);
    expect(persistIndex).toBeGreaterThan(pollIndex);
    expect(finalCheckIndex).toBe(-1);
  });

  it('keeps locally failed completed canvas tasks recoverable instead of forcing regeneration', () => {
    expect(canvasEditorSource).toContain('recoverableGenerationTask ? true : false');

    const failedRecoveryIndex = canvasEditorSource.indexOf('recoverableGenerationTask ? true : false');
    const activeNodesIndex = canvasEditorSource.indexOf('const activeNodes = nodes.filter');
    const activeErrorRecoveryIndex = canvasEditorSource.indexOf('s === "error" && node.metadata?.recoverableGenerationTask === true', activeNodesIndex);

    expect(failedRecoveryIndex).toBeGreaterThan(-1);
    expect(activeErrorRecoveryIndex).toBeGreaterThan(activeNodesIndex);
  });
});

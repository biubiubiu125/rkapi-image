import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadAndStoreImages } from '@/lib/image-downloader';
import { createFlyreqTask, getFlyreqTask, resolveImageTaskProvider } from '@/lib/flyreq-task-client';
import { ackServerTaskWithRetry, cancelServerTaskWithRetry } from '@/lib/server-task-ack';
import { flyreqTaskSocket } from '@/lib/flyreq-task-socket';
import { loadActiveGifJob, saveActiveGifJob, type ActiveGifJob } from '@/lib/gif-job-store';
import { cacheGifGridImage, useGifWorkflow, type SubmitInput } from '@/hooks/useGifWorkflow';

vi.mock('@/lib/image-downloader', async () => {
  const actual = await vi.importActual<typeof import('@/lib/image-downloader')>('@/lib/image-downloader');
  return {
    ...actual,
    downloadAndStoreImages: vi.fn(),
    makeStoredBlobRef: vi.fn((jobId: string, index: number) => `IDB:${jobId}-${index}`),
  };
});

vi.mock('@/lib/flyreq-task-client', () => ({
  createFlyreqTask: vi.fn(),
  getFlyreqTask: vi.fn(),
  normalizeFlyreqTaskAccess: vi.fn((access: string | { taskId: string; readToken?: string }) => (
    typeof access === 'string' ? { taskId: access } : access
  )),
  resolveImageTaskProvider: vi.fn(),
}));

vi.mock('@/lib/flyreq-task-socket', () => ({
  flyreqTaskSocket: {
    subscribeTask: vi.fn(() => vi.fn()),
  },
}));

vi.mock('@/lib/server-task-ack', () => ({
  ackServerTaskWithRetry: vi.fn(async () => true),
  cancelServerTaskWithRetry: vi.fn(async () => true),
}));

const mockedDownloadAndStoreImages = vi.mocked(downloadAndStoreImages);
const mockedCreateFlyreqTask = vi.mocked(createFlyreqTask);
const mockedGetFlyreqTask = vi.mocked(getFlyreqTask);
const mockedResolveImageTaskProvider = vi.mocked(resolveImageTaskProvider);
const mockedAckServerTaskWithRetry = vi.mocked(ackServerTaskWithRetry);
const mockedCancelServerTaskWithRetry = vi.mocked(cancelServerTaskWithRetry);
const mockedSubscribeTask = vi.mocked(flyreqTaskSocket.subscribeTask);

const activeJob: ActiveGifJob = {
  id: 'gif-job',
  status: 'generating_grid',
  prompt: '动起来',
  loop: true,
  closedLoop: false,
  model: 'rkapi-4k-image',
  refImages: [],
  frameDelayMs: 120,
  loopCount: 0,
  framePadding: 1.5,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const submitInput: SubmitInput = {
  prompt: '动起来',
  loop: true,
  closedLoop: false,
  model: 'rkapi-4k-image',
  gptImageQuality: 'auto',
  gptImageStyle: 'auto',
  gptImageBackground: 'auto',
  gptImageOutputFormat: 'png',
  refImages: [],
  frameDelayMs: 120,
  loopCount: 0,
  framePadding: 1.5,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
  if (typeof URL.revokeObjectURL !== 'function') {
    URL.revokeObjectURL = vi.fn();
  }
  mockedResolveImageTaskProvider.mockReturnValue({
    apiKey: 'image-key',
    baseUrl: 'https://image.example.com',
    protocol: 'openai',
    modelId: 'gpt-image-2',
  });
  mockedCreateFlyreqTask.mockResolvedValue('task-1');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['template'], { type: 'image/png' }), { status: 200 })));
});

describe('GIF grid image storage', () => {
  it('does not allow server ack when the grid image is still only a remote URL', async () => {
    mockedDownloadAndStoreImages.mockResolvedValue({
      successCount: 0,
      failCount: 1,
      blobUrls: [''],
      items: [{ index: 0, status: 'failed', loadedBytes: 0 }],
    });

    const result = await cacheGifGridImage('gif-job', 'URL:/api/flyreq/images/task-1/0/0');

    expect(result).toEqual({
      gridImageRef: 'URL:/api/flyreq/images/task-1/0/0',
      immediateBlobUrl: null,
      shouldAckServerTask: false,
    });
  });

  it('allows server ack after the grid image is persisted locally', async () => {
    mockedDownloadAndStoreImages.mockResolvedValue({
      successCount: 1,
      failCount: 0,
      blobUrls: ['blob:grid'],
      items: [{ index: 0, status: 'cached', loadedBytes: 12 }],
    });

    const result = await cacheGifGridImage('gif-job', 'URL:/api/flyreq/images/task-1/0/0');

    expect(result).toEqual({
      gridImageRef: 'IDB:gif-job-0',
      immediateBlobUrl: 'blob:grid',
      shouldAckServerTask: true,
    });
  });

  it('marks review grid as recoverable and unacked when local grid caching falls back to remote URL', async () => {
    let taskHandler: ((task: Parameters<Parameters<typeof flyreqTaskSocket.subscribeTask>[2]>[0]) => void) | null = null;
    mockedSubscribeTask.mockImplementation((...args: unknown[]) => {
      const handler = args[args.length - 1];
      if (typeof handler === 'function') taskHandler = handler as typeof taskHandler;
      return vi.fn();
    });
    mockedDownloadAndStoreImages.mockResolvedValue({
      successCount: 0,
      failCount: 1,
      blobUrls: [''],
      items: [{ index: 0, status: 'failed', loadedBytes: 0 }],
    });
    const { result } = renderHook(() => useGifWorkflow());

    await act(async () => {
      await result.current.submitGrid(submitInput);
    });

    await act(async () => {
      taskHandler?.({
        id: 'task-1',
        status: 'completed',
        result: { images: ['URL:/api/flyreq/images/task-1/0/0'] },
      });
    });

    await waitFor(() => {
      expect(result.current.job).toMatchObject({
        status: 'review_grid',
        gridImageRef: 'URL:/api/flyreq/images/task-1/0/0',
        serverTaskAcked: false,
      });
    });
    expect(result.current.job?.error).toContain('本地缓存失败');
    expect(result.current.gridImageUrl).toBe('/api/flyreq/images/task-1/0/0');
    expect(mockedAckServerTaskWithRetry).not.toHaveBeenCalled();
  });

  it('keeps a locally cached GIF grid unacked until the server ack succeeds', async () => {
    let taskHandler: ((task: Parameters<Parameters<typeof flyreqTaskSocket.subscribeTask>[2]>[0]) => void) | null = null;
    mockedSubscribeTask.mockImplementation((...args: unknown[]) => {
      const handler = args[args.length - 1];
      if (typeof handler === 'function') taskHandler = handler as typeof taskHandler;
      return vi.fn();
    });
    mockedDownloadAndStoreImages.mockResolvedValue({
      successCount: 1,
      failCount: 0,
      blobUrls: ['blob:grid'],
      items: [{ index: 0, status: 'cached', loadedBytes: 12 }],
    });
    mockedAckServerTaskWithRetry.mockResolvedValue(false);
    const { result } = renderHook(() => useGifWorkflow());

    await act(async () => {
      await result.current.submitGrid(submitInput);
    });
    await act(async () => {
      taskHandler?.({
        id: 'task-1',
        status: 'completed',
        result: { images: ['URL:/api/flyreq/images/task-1/0/0'] },
      });
    });

    await waitFor(() => {
      expect(result.current.job).toMatchObject({
        status: 'review_grid',
        serverTaskAcked: false,
      });
    });
    expect(result.current.job?.gridImageRef).toMatch(/^IDB:.+-0$/);
    expect(result.current.job?.error).toContain('服务端清理确认失败');
  });

  it('does not resurrect a reset GIF job when a late server ack failure returns', async () => {
    let taskHandler: ((task: Parameters<Parameters<typeof flyreqTaskSocket.subscribeTask>[2]>[0]) => void) | null = null;
    let resolveAck: ((value: boolean) => void) | null = null;
    mockedSubscribeTask.mockImplementation((...args: unknown[]) => {
      const handler = args[args.length - 1];
      if (typeof handler === 'function') taskHandler = handler as typeof taskHandler;
      return vi.fn();
    });
    mockedDownloadAndStoreImages.mockResolvedValue({
      successCount: 1,
      failCount: 0,
      blobUrls: ['blob:grid'],
      items: [{ index: 0, status: 'cached', loadedBytes: 12 }],
    });
    mockedAckServerTaskWithRetry.mockImplementation(() => new Promise<boolean>(resolve => {
      resolveAck = resolve;
    }));
    const { result } = renderHook(() => useGifWorkflow());

    await act(async () => {
      await result.current.submitGrid(submitInput);
    });
    await act(async () => {
      taskHandler?.({
        id: 'task-1',
        status: 'completed',
        result: { images: ['URL:/api/flyreq/images/task-1/0/0'] },
      });
    });
    await waitFor(() => {
      expect(result.current.job).toMatchObject({ status: 'review_grid', serverTaskAcked: false });
    });

    await act(async () => {
      await result.current.resetJob();
    });
    expect(result.current.job).toBeNull();
    expect(mockedCancelServerTaskWithRetry).toHaveBeenCalledWith('task-1', undefined);

    await act(async () => {
      resolveAck?.(false);
    });
    expect(result.current.job).toBeNull();
  });
});

describe('GIF active job persistence', () => {
  it('reports save failure when localStorage rejects', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    expect(saveActiveGifJob(activeJob)).toBe(false);
  });

  it('persists a recoverable GIF task snapshot when the full job exceeds localStorage quota', () => {
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItemWithQuota(this: Storage, key: string, value: string) {
      if (value.includes('data:image/png;base64')) {
        throw new Error('quota exceeded');
      }
      return originalSetItem.call(this, key, value);
    });

    expect(saveActiveGifJob({
      ...activeJob,
      serverTaskId: 'task-1',
      refImages: [{
        id: 'ref-1',
        name: 'large.png',
        dataUrl: 'data:image/png;base64,large-reference',
        mimeType: 'image/png',
      }],
    })).toBe(true);

    expect(loadActiveGifJob()).toMatchObject({
      id: 'gif-job',
      serverTaskId: 'task-1',
      refImages: [],
    });
  });

  it('does not subscribe to a server task when the GIF task id still cannot be persisted', async () => {
    const originalSetItem = Storage.prototype.setItem;
    let writes = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItemWithQuota(this: Storage, key: string, value: string) {
      writes += 1;
      if (writes > 1) throw new Error('quota exceeded');
      return originalSetItem.call(this, key, value);
    });
    const { result } = renderHook(() => useGifWorkflow());

    await act(async () => {
      await expect(result.current.submitGrid(submitInput)).rejects.toThrow('浏览器本地持久存储不可用');
    });

    expect(result.current.job).toMatchObject({
      status: 'failed',
      serverTaskId: 'task-1',
    });
    expect(result.current.job?.error).toContain('task-1');
    expect(mockedCancelServerTaskWithRetry).toHaveBeenCalledWith('task-1', undefined);
    expect(mockedSubscribeTask).not.toHaveBeenCalled();
  });

  it('does not create a server task when the initial GIF job cannot be persisted', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const { result } = renderHook(() => useGifWorkflow());

    await act(async () => {
      await expect(result.current.submitGrid(submitInput)).rejects.toThrow('浏览器本地持久存储不可用');
    });

    expect(mockedCreateFlyreqTask).not.toHaveBeenCalled();
  });

  it('keeps the completed server task recoverable when final GIF metadata cannot persist', async () => {
    let taskHandler: ((task: Parameters<Parameters<typeof flyreqTaskSocket.subscribeTask>[2]>[0]) => void) | null = null;
    mockedSubscribeTask.mockImplementation((...args: unknown[]) => {
      const handler = args[args.length - 1];
      if (typeof handler === 'function') taskHandler = handler as typeof taskHandler;
      return vi.fn();
    });
    mockedDownloadAndStoreImages.mockResolvedValue({
      successCount: 1,
      failCount: 0,
      blobUrls: ['blob:grid'],
      items: [{ index: 0, status: 'cached', loadedBytes: 12 }],
    });
    const originalSetItem = Storage.prototype.setItem;
    let writes = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItemWithQuota(this: Storage, key: string, value: string) {
      writes += 1;
      if (writes >= 3) throw new Error('quota exceeded');
      return originalSetItem.call(this, key, value);
    });
    const { result } = renderHook(() => useGifWorkflow());

    await act(async () => {
      await result.current.submitGrid(submitInput);
    });
    expect(result.current.job?.serverTaskId).toBe('task-1');

    await act(async () => {
      taskHandler?.({
        id: 'task-1',
        status: 'completed',
        result: { images: ['URL:/api/flyreq/images/task-1/0/0'] },
      });
    });

    await waitFor(() => {
      expect(result.current.job?.status).toBe('generating_grid');
      expect(result.current.job?.error).toContain('浏览器本地持久存储不可用');
    });
    expect(result.current.job?.serverTaskId).toBe('task-1');
    expect(mockedAckServerTaskWithRetry).not.toHaveBeenCalled();
  });

  it('keeps a server GIF task recoverable when manual status refresh fails', async () => {
    const { result } = renderHook(() => useGifWorkflow());

    await act(async () => {
      await result.current.submitGrid(submitInput);
    });

    mockedSubscribeTask.mockClear();
    mockedGetFlyreqTask.mockRejectedValueOnce(new Error('temporary network'));

    await act(async () => {
      await result.current.refreshFromServer();
    });

    expect(result.current.job).toMatchObject({
      status: 'generating_grid',
      serverTaskId: 'task-1',
    });
    expect(result.current.job?.error).toContain('temporary network');
    expect(mockedSubscribeTask).toHaveBeenCalledWith('task-1', undefined, expect.any(Function));
  });
});

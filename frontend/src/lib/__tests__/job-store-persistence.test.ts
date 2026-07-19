import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredJob } from '@/lib/job-store';

function makeCompletedJob(overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    id: 'job-1',
    status: 'completed',
    mode: 'text-to-image',
    prompt: 'prompt',
    output_size: '1K',
    temperature: 1,
    aspect_ratio: '1:1',
    model: 'rkapi-4k-image',
    created_at: '2026-06-07T00:00:00.000Z',
    completed_at: '2026-06-07T00:00:10.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
});

describe('job result persistence', () => {
  it('reports image metadata persistence failure when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    vi.resetModules();
    const { saveImage } = await import('@/lib/job-store');

    await expect(saveImage(makeCompletedJob({ images: ['blob:cached-0'], imageData: 'blob:cached-0' })))
      .rejects.toThrow('浏览器本地持久存储不可用');
  });

  it('keeps unacked remote image refs in localStorage so completed jobs can survive refresh before ack', async () => {
    vi.resetModules();
    const { loadJobs, saveJobs } = await import('@/lib/job-store');

    saveJobs([
      makeCompletedJob({
        images: ['URL:/api/flyreq/images/task-1/0/0'],
        imageData: 'URL:/api/flyreq/images/task-1/0/0',
        serverTaskId: 'task-1',
        serverTaskAcked: false,
      }),
    ]);

    expect(loadJobs()[0]).toMatchObject({
      images: ['URL:/api/flyreq/images/task-1/0/0'],
      imageData: 'URL:/api/flyreq/images/task-1/0/0',
      serverTaskAcked: false,
    });
  });

  it('treats unacked remote image refs as renderable after a refresh before local cache succeeds', async () => {
    vi.resetModules();
    const { isCompletedJobImageRenderable } = await import('@/lib/job-store');

    const remoteJob = makeCompletedJob({
      images: ['URL:/api/flyreq/images/task-1/0/0'],
      imageData: 'URL:/api/flyreq/images/task-1/0/0',
      serverTaskId: 'task-1',
      serverTaskAcked: false,
    });

    expect(isCompletedJobImageRenderable(remoteJob, new Set())).toBe(true);
    expect(isCompletedJobImageRenderable(remoteJob, new Set(['job-1']))).toBe(true);
    expect(isCompletedJobImageRenderable(makeCompletedJob({ images: ['IDB:job-1-0'] }), new Set())).toBe(false);
  });

  it('reports task list persistence failure when localStorage rejects the write', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });
    vi.resetModules();
    const { saveJobs } = await import('@/lib/job-store');

    expect(saveJobs([makeCompletedJob()])).toBe(false);
  });
});

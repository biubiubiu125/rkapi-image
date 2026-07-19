import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadAndStoreImages,
  fetchImageAsBlob,
  getStoredBlob,
  type ImageDownloadProgressItem,
} from '@/lib/image-downloader';

function makeStream(chunks: number[][], failAtIndex?: number): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAtIndex !== undefined && index === failAtIndex) {
        controller.error(new Error('stream failed'));
        return;
      }
      const chunk = chunks[index];
      if (!chunk) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(new Uint8Array(chunk));
    },
  });
}

function mockImageFetch(response: Response): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchImageAsBlob', () => {
  it('按 Content-Length 上报流式下载进度', async () => {
    const progress: Array<{ loadedBytes: number; totalBytes?: number; percent?: number }> = [];
    mockImageFetch(new Response(makeStream([[1, 2], [3, 4]]), {
      headers: {
        'content-length': '4',
        'content-type': 'image/png',
      },
    }));

    const blob = await fetchImageAsBlob('/image.png', 1, item => progress.push(item));

    expect(blob.size).toBe(4);
    expect(progress).toEqual([
      { loadedBytes: 0, totalBytes: 4, percent: 0 },
      { loadedBytes: 2, totalBytes: 4, percent: 50 },
      { loadedBytes: 4, totalBytes: 4, percent: 100 },
    ]);
  });

  it('未知总大小时仍上报已下载字节', async () => {
    const progress: Array<{ loadedBytes: number; totalBytes?: number; percent?: number }> = [];
    mockImageFetch(new Response(makeStream([[1], [2, 3]]), {
      headers: { 'content-type': 'image/png' },
    }));

    const blob = await fetchImageAsBlob('/image.png', 1, item => progress.push(item));

    expect(blob.size).toBe(3);
    expect(progress.at(-1)).toMatchObject({ loadedBytes: 3 });
    expect(progress.at(-1)?.totalBytes).toBeUndefined();
    expect(progress.at(-1)?.percent).toBeUndefined();
  });

  it('HTTP 非 2xx 时抛出状态码错误', async () => {
    mockImageFetch(new Response('bad gateway', { status: 502 }));

    await expect(fetchImageAsBlob('/image.png', 1)).rejects.toThrow('HTTP 502');
  });

  it('body 读取中断时抛出流错误', async () => {
    const progress: Array<{ loadedBytes: number }> = [];
    mockImageFetch(new Response(makeStream([[1]], 1), {
      headers: { 'content-length': '2' },
    }));

    await expect(fetchImageAsBlob('/image.png', 1, item => progress.push(item))).rejects.toThrow('stream failed');
    expect(progress.some(item => item.loadedBytes === 1)).toBe(true);
  });
});

describe('downloadAndStoreImages', () => {
  it('IndexedDB 不可用时保留内存兜底但不把结果标记为持久缓存成功', async () => {
    const progress: ImageDownloadProgressItem[] = [];
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:cached-0'),
      revokeObjectURL: vi.fn(),
    });
    mockImageFetch(new Response(makeStream([[1, 2]]), {
      headers: {
        'content-length': '2',
        'content-type': 'image/png',
      },
    }));

    const result = await downloadAndStoreImages('job-fallback', ['URL:/image.png'], {
      maxRetries: 1,
      onProgress: item => progress.push(item),
    });

    expect(result.successCount).toBe(0);
    expect(result.failCount).toBe(1);
    expect(result.blobUrls).toEqual(['']);
    expect(result.items[0]).toMatchObject({
      index: 0,
      status: 'failed',
      loadedBytes: 2,
      totalBytes: 2,
      percent: 100,
      error: '浏览器本地持久存储不可用',
    });
    expect(progress.some(item => item.status === 'downloading' && item.percent === 100)).toBe(true);
    await expect(getStoredBlob('job-fallback', 0)).resolves.toMatchObject({ size: 2 });
  });
});

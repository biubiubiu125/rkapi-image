import { afterEach, describe, expect, it, vi } from 'vitest';
import { storeImageBlob } from '@/lib/image-downloader';
import { clearPendingGeneration, loadPendingGeneration, putImageRecord, putMessage, savePendingGeneration, savePendingProposal, storeAgentImageBytes } from '@/lib/agent-context-store';

vi.mock('@/lib/image-downloader', () => ({
  getStoredBlob: vi.fn(),
  storeImageBlob: vi.fn(),
}));

const mockedStoreImageBlob = vi.mocked(storeImageBlob);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('agent image byte storage', () => {
  it('reports persistent storage failure instead of silently registering volatile image bytes', async () => {
    mockedStoreImageBlob.mockResolvedValue(false);

    await expect(storeAgentImageBytes('img-1', new Blob(['image'], { type: 'image/png' })))
      .rejects.toThrow('浏览器本地持久存储不可用');
  });
});

describe('agent context record persistence', () => {
  it('reports message persistence failure when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);

    await expect(putMessage({
      id: 'msg-1',
      role: 'assistant',
      text: 'done',
      createdAt: 1,
    })).rejects.toThrow('浏览器本地持久存储不可用');
  });

  it('reports image record persistence failure when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);

    await expect(putImageRecord({
      imgId: 'img_1',
      source: 'generated',
      thumbnail: 'data:image/png;base64,aW1hZ2U=',
      description: '',
      mimeType: 'image/png',
      createdAt: 1,
    })).rejects.toThrow('浏览器本地持久存储不可用');
  });

  it('falls back to localStorage for pending generation when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);

    await savePendingGeneration({
      taskId: 'task-1',
      proposal: {
        action: 'generate',
        prompt: '画一张图',
        referencedImageIds: [],
        reason: '',
        parallelCount: 1,
      },
      pendingAnalysis: '',
      pendingReasoning: '',
      selectedImageIds: [],
      model: 'rkapi-4k-image',
      outputSize: '1K',
      aspectRatio: '1:1',
      temperature: 1,
      parallelCount: 1,
      startedAt: 1,
    });

    await expect(loadPendingGeneration()).resolves.toMatchObject({ taskId: 'task-1' });

    await clearPendingGeneration();
    await expect(loadPendingGeneration()).resolves.toBeNull();
  });

  it('reports pending generation persistence failure when both IndexedDB and fallback storage are unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    await expect(savePendingGeneration({
      taskId: 'task-1',
      proposal: {
        action: 'generate',
        prompt: '画一张图',
        referencedImageIds: [],
        reason: '',
        parallelCount: 1,
      },
      pendingAnalysis: '',
      pendingReasoning: '',
      selectedImageIds: [],
      model: 'rkapi-4k-image',
      outputSize: '1K',
      aspectRatio: '1:1',
      temperature: 1,
      parallelCount: 1,
      startedAt: 1,
    })).rejects.toThrow('浏览器本地持久存储不可用');
  });

  it('reports pending proposal persistence failure when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);

    await expect(savePendingProposal({
      proposal: {
        action: 'generate',
        prompt: '画一张图',
        referencedImageIds: [],
        reason: '',
        parallelCount: 1,
      },
      pendingAnalysis: '',
      pendingReasoning: '',
      isReedit: false,
    })).rejects.toThrow('浏览器本地持久存储不可用');
  });
});

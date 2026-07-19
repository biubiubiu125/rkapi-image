import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ackFlyreqTask, getFlyreqTask } from '@/lib/flyreq-task-client';
import { uploadImage } from '@/components/canvas/lib/image-storage';
import { checkExistingTask, pollNodeTask } from '@/components/canvas/canvas-generation-service';

vi.mock('@/lib/flyreq-task-client', () => ({
  ackFlyreqTask: vi.fn(),
  createFlyreqTask: vi.fn(),
  getFlyreqTask: vi.fn(),
  resolveImageTaskProvider: vi.fn(),
}));

vi.mock('@/components/canvas/lib/image-storage', () => ({
  uploadImage: vi.fn(),
}));

const mockedAckFlyreqTask = vi.mocked(ackFlyreqTask);
const mockedGetFlyreqTask = vi.mocked(getFlyreqTask);
const mockedUploadImage = vi.mocked(uploadImage);

describe('canvas generation service result storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not ack the server task when completed images cannot be saved locally', async () => {
    mockedGetFlyreqTask.mockResolvedValue({
      id: 'task-1',
      status: 'completed',
      result: { images: ['URL:/api/flyreq/images/task-1/0/0'] },
    });
    mockedUploadImage.mockRejectedValue(new Error('idb unavailable'));

    await expect(pollNodeTask('task-1', undefined, () => undefined)).rejects.toThrow('生成结果保存失败');

    expect(mockedAckFlyreqTask).not.toHaveBeenCalled();
  });

  it('keeps restored completed tasks unacked when local save fails', async () => {
    mockedGetFlyreqTask.mockResolvedValue({
      id: 'task-1',
      status: 'completed',
      result: { images: ['URL:/api/flyreq/images/task-1/0/0'] },
    });
    mockedUploadImage.mockRejectedValue(new Error('idb unavailable'));

    await expect(checkExistingTask('task-1')).resolves.toEqual({
      status: 'failed',
      error: '生成结果保存失败',
    });
    expect(mockedAckFlyreqTask).not.toHaveBeenCalled();
  });

  it('returns stored images without acking before the canvas project is persisted', async () => {
    mockedGetFlyreqTask.mockResolvedValue({
      id: 'task-1',
      status: 'completed',
      result: { images: ['URL:/api/flyreq/images/task-1/0/0'] },
    });
    mockedUploadImage.mockResolvedValue({
      storageKey: 'canvas-image-1',
      url: 'blob:canvas-image-1',
      width: 512,
      height: 512,
      mimeType: 'image/png',
      bytes: 12,
    });

    await expect(pollNodeTask('task-1', undefined, () => undefined)).resolves.toEqual([
      {
        storageKey: 'canvas-image-1',
        url: 'blob:canvas-image-1',
        width: 512,
        height: 512,
        mimeType: 'image/png',
        bytes: 12,
      },
    ]);
    expect(mockedAckFlyreqTask).not.toHaveBeenCalled();
  });
});

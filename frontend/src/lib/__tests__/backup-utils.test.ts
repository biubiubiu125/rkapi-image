import { unzipSync, zipSync } from 'fflate';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backupUtilsSource = fs.readFileSync(
  path.resolve(testDir, '../backup-utils.ts'),
  'utf8',
);

vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn((config: { storeName: string }) => ({
      iterate: vi.fn(async (callback: (value: unknown, key: string) => void) => {
        if (config.storeName !== 'canvas_app_state') return;
        const blob = new Blob(['canvas-bytes'], { type: 'text/plain' });
        Object.defineProperty(blob, 'arrayBuffer', {
          value: async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
            const bytes = new TextEncoder().encode('canvas-bytes');
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          },
        });
        callback(blob, 'canvas-key');
      }),
      clear: vi.fn(),
      setItem: vi.fn(),
    })),
  },
}));

/**
 * 兼容 jsdom Blob：部分测试环境没有 Blob.arrayBuffer，需要通过 FileReader 读取导出的 ZIP。
 * @param blob 待读取的 Blob。
 * @returns Blob 的 ArrayBuffer 内容。
 */
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe('backup-utils', () => {
  it('导出无限画布 localforage Blob 前会等待二进制写入 ZIP', async () => {
    const { exportAllData } = await import('@/lib/backup-utils');
    const backup = await exportAllData(undefined, 'test');
    const unzipped = unzipSync(new Uint8Array(await readBlob(backup)));
    const localForageData = JSON.parse(new TextDecoder().decode(unzipped['localforage/flyreq-image.json'])) as {
      canvas_app_state: Array<{ key: string; _blobRef: string; _blobMimeType: string }>;
    };
    const entry = localForageData.canvas_app_state[0];

    expect(entry).toMatchObject({ key: 'canvas-key', _blobMimeType: 'text/plain' });
    expect(unzipped[`blobs/${entry._blobRef}`]).toBeDefined();
    expect(new TextDecoder().decode(unzipped[`blobs/${entry._blobRef}`])).toBe('canvas-bytes');
  });

  it('导入遇到缺失的 blob 引用时不会先清空 localStorage', async () => {
    const { importAllData } = await import('@/lib/backup-utils');
    localStorage.setItem('rkapi-token', 'keep-me');
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem');
    const backup = zipSync({
      'metadata.json': new TextEncoder().encode(JSON.stringify({ incremental: false })),
      'localStorage.json': new TextEncoder().encode(JSON.stringify({ 'rkapi-token': 'keep-me' })),
      'localforage/flyreq-image.json': new TextEncoder().encode(JSON.stringify({
        canvas_app_state: [{ key: 'canvas-key', _blobRef: 'missing-blob', _blobMimeType: 'image/png' }],
      })),
    });

    const file = {
      arrayBuffer: async () => backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength),
    } as File;

    await expect(importAllData(file)).rejects.toThrow(/missing-blob/);

    expect(localStorage.getItem('rkapi-token')).toBe('keep-me');
    expect(removeItemSpy).not.toHaveBeenCalled();
    removeItemSpy.mockRestore();
  });

  it('备份文件名使用 RKAPI 前缀', async () => {
    const { generateBackupFilename } = await import('@/lib/backup-utils');

    const filename = generateBackupFilename();

    expect(filename.startsWith('rkapi-backup-')).toBe(true);
    expect(filename).toContain('.zip');
    expect(filename).not.toContain('flyreq');
  });

  it('完整备份包含提示词优化开关和共享生图设置', async () => {
    const { exportAllData } = await import('@/lib/backup-utils');
    localStorage.setItem('flyreq-prompt-optimize-enabled', 'true');
    localStorage.setItem('flyreq-image-generation-settings', JSON.stringify({ model: 'rkapi-4k-image' }));

    const backup = await exportAllData(undefined, 'test');
    const unzipped = unzipSync(new Uint8Array(await readBlob(backup)));
    const localStorageData = JSON.parse(new TextDecoder().decode(unzipped['localStorage.json'])) as Record<string, string>;

    expect(localStorageData['flyreq-prompt-optimize-enabled']).toBe('true');
    expect(localStorageData['flyreq-image-generation-settings']).toContain('rkapi-4k-image');
  });

  it('导入 IndexedDB 时必须在事务内清空目标 store 再写入', () => {
    expect(backupUtilsSource).toContain('store.clear()');
    expect(backupUtilsSource).toContain("db.transaction(storeDataList.map(item => item.storeName), 'readwrite')");
    expect(backupUtilsSource).toContain('await replaceDatabaseStores(db, processedStores)');
  });

  it('导入进度和非完整备份错误使用可读中文文案', async () => {
    const { importAllData } = await import('@/lib/backup-utils');
    const progress: string[] = [];
    const backup = zipSync({
      'metadata.json': new TextEncoder().encode(JSON.stringify({ incremental: true })),
    });
    const file = {
      arrayBuffer: async () => backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength),
    } as File;

    await expect(importAllData(file, item => progress.push(item.message)))
      .rejects.toThrow('不支持导入非完整备份文件');

    expect(progress.slice(0, 2)).toEqual([
      '开始导入数据...',
      '正在解压文件...',
    ]);
  });

  it('localStorage 导入失败时恢复原有设置并抛出错误', async () => {
    const { importAllData } = await import('@/lib/backup-utils');
    localStorage.setItem('theme', 'light');
    const originalSetItem = Storage.prototype.setItem;
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(key: string, value: string) {
      if (key === 'theme' && value === 'dark') {
        throw new Error('quota exceeded');
      }
      return originalSetItem.call(this, key, value);
    });
    const backup = zipSync({
      'metadata.json': new TextEncoder().encode(JSON.stringify({ incremental: false })),
      'localStorage.json': new TextEncoder().encode(JSON.stringify({ theme: 'dark' })),
    });
    const file = {
      arrayBuffer: async () => backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength),
    } as File;

    try {
      await expect(importAllData(file)).rejects.toThrow('localStorage 导入失败');
      expect(localStorage.getItem('theme')).toBe('light');
    } finally {
      setItemSpy.mockRestore();
    }
  });
});

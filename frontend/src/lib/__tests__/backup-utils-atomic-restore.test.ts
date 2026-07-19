import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn((config: { storeName: string }) => ({
      iterate: vi.fn(async (callback: (value: unknown, key: string) => void) => {
        if (config.storeName !== 'canvas_app_state') return;
        const blob = new Blob(['canvas-bytes'], { type: 'text/plain' });
        callback(blob, 'canvas-key');
      }),
      clear: vi.fn(),
      setItem: vi.fn(),
    })),
  },
}));

describe('backup-utils atomic restore', () => {
  it('keeps existing localStorage values when localforage import fails', async () => {
    const { importAllData } = await import('@/lib/backup-utils');
    const localforageModule = await import('localforage');
    const createInstance = localforageModule.default.createInstance;
    const originalImplementation = createInstance.getMockImplementation();

    localStorage.setItem('theme', 'light');

    createInstance.mockImplementation((config: { storeName: string }) => ({
      iterate: vi.fn(async (callback: (value: unknown, key: string) => void) => {
        if (config.storeName !== 'canvas_app_state') return;
        const blob = new Blob(['canvas-bytes'], { type: 'text/plain' });
        callback(blob, 'canvas-key');
      }),
      clear: vi.fn(async () => undefined),
      setItem: vi.fn(async () => {
        throw new Error('localforage write failed');
      }),
    }));

    const backup = zipSync({
      'metadata.json': new TextEncoder().encode(JSON.stringify({ incremental: false })),
      'localStorage.json': new TextEncoder().encode(JSON.stringify({ theme: 'dark' })),
      'localforage/flyreq-image.json': new TextEncoder().encode(JSON.stringify({
        canvas_app_state: [{ key: 'canvas-key', _blobRef: 'canvas-blob', _blobMimeType: 'text/plain' }],
      })),
      'blobs/canvas-blob': new TextEncoder().encode('canvas-bytes'),
    });

    const file = {
      arrayBuffer: async () => backup.buffer.slice(backup.byteOffset, backup.byteOffset + backup.byteLength),
    } as File;

    try {
      await expect(importAllData(file)).rejects.toThrow('localforage write failed');
      expect(localStorage.getItem('theme')).toBe('light');
    } finally {
      if (originalImplementation) {
        createInstance.mockImplementation(originalImplementation);
      } else {
        createInstance.mockReset();
      }
    }
  });
});

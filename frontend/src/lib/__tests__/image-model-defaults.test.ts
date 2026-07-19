import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultModelId } from '@/lib/gemini-config';
import { applyImageModelToDefaultTasks } from '@/lib/flyreq-models';

const storage = new Map<string, string>();

describe('image model defaults', () => {
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      clear: () => { storage.clear(); },
    });
    storage.set('flyreq-model-registry', JSON.stringify({
      imageModels: [
        {
          id: 'rkapi-reverse-image',
          protocol: 'openai',
          name: 'RKAPI-逆向',
          modelId: 'gpt-image-2',
          apiKey: 'reverse-key',
          baseUrl: 'https://api.rkai6.com',
          builtinPreset: 'gpt-image-2',
          maxRefImages: 16,
          maxOutputSize: '4K',
          supportsAdvancedParams: true,
        },
        {
          id: 'rkapi-4k-image',
          protocol: 'openai',
          name: 'RKAPI-4k',
          modelId: 'gpt-image-2',
          apiKey: '4k-key',
          baseUrl: 'https://api.rkai6.com',
          builtinPreset: 'gpt-image-2',
          maxRefImages: 16,
          maxOutputSize: '4K',
          supportsAdvancedParams: true,
        },
      ],
      textModels: [],
      defaults: {
        textToImage: 'rkapi-4k-image',
        imageToImage: 'rkapi-reverse-image',
      },
    }));
  });

  afterEach(() => {
    storage.clear();
    vi.restoreAllMocks();
  });

  it('returns task-specific RKAPI default image models', () => {
    expect(getDefaultModelId()).toBe('rkapi-4k-image');
    expect(getDefaultModelId('textToImage')).toBe('rkapi-4k-image');
    expect(getDefaultModelId('imageToImage')).toBe('rkapi-reverse-image');
  });

  it('returns task-specific RKAPI defaults before API keys are filled', () => {
    storage.delete('flyreq-model-registry');

    expect(getDefaultModelId()).toBe('rkapi-4k-image');
    expect(getDefaultModelId('textToImage')).toBe('rkapi-4k-image');
    expect(getDefaultModelId('imageToImage')).toBe('rkapi-reverse-image');
  });

  it('applies RKAPI image models only to their intended default tasks', () => {
    const defaults = applyImageModelToDefaultTasks({
      textToImage: 'rkapi-4k-image',
      imageToImage: 'rkapi-reverse-image',
      reversePrompt: '',
      agent: '',
      promptOptimize: '',
      imageDescribe: '',
    }, 'rkapi-4k-image');

    expect(defaults.textToImage).toBe('rkapi-4k-image');
    expect(defaults.imageToImage).toBe('rkapi-reverse-image');

    expect(applyImageModelToDefaultTasks(defaults, 'rkapi-reverse-image')).toMatchObject({
      textToImage: 'rkapi-4k-image',
      imageToImage: 'rkapi-reverse-image',
    });
    expect(applyImageModelToDefaultTasks(defaults, 'custom-image')).toMatchObject({
      textToImage: 'custom-image',
      imageToImage: 'custom-image',
    });
  });
});

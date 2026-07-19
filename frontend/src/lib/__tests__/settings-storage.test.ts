import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canEnablePromptOptimize,
  hasAnyApiKey,
  hasConfiguredImageModel,
  hasConfiguredTextModel,
  isPromptOptimizeEnabled,
  loadJsonFromStorage,
  setPromptOptimizeEnabled,
} from '@/lib/settings-storage';
import { BUILTIN_IMAGE_PRESETS, getResolvedImageModelId, loadRegistry } from '@/lib/flyreq-models';
import { migrateRkapiImageFormDefaults, saveImageModelFormDefaults } from '@/lib/form-settings';
import { checkModelsAvailability, resolveImageTaskProvider } from '@/lib/flyreq-task-client';
import {
  getEnabledTextModelsForSettingsSave,
  getPersistableTextModelsForSettingsSave,
  getSettingsModelSaveError,
} from '@/lib/settings-text-models';

const storage = new Map<string, string>();

function writeRegistry(registry: unknown) {
  storage.set('flyreq-model-registry', JSON.stringify(registry));
}

describe('settings-storage model availability', () => {
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      clear: () => { storage.clear(); },
    });
  });

  afterEach(() => {
    storage.clear();
    vi.restoreAllMocks();
  });

  it('unlocks image workflows with only a complete image model', () => {
    writeRegistry({
      imageModels: [{
        id: 'img-1',
        protocol: 'openai',
        name: 'Image',
        modelId: 'gpt-image-2',
        apiKey: 'key',
        baseUrl: 'https://api.openai.com',
        builtinPreset: 'gpt-image-2',
        maxRefImages: 16,
        maxOutputSize: '4K',
        supportsAdvancedParams: true,
      }],
      textModels: [],
      defaults: { textToImage: 'img-1', imageToImage: 'img-1' },
    });

    expect(hasConfiguredImageModel()).toBe(true);
    expect(hasConfiguredTextModel()).toBe(false);
    expect(hasAnyApiKey()).toBe(true);
  });

  it('does not treat incomplete text-only config as image workflow availability', () => {
    writeRegistry({
      imageModels: [],
      textModels: [{
        id: 'txt-1',
        protocol: 'openai',
        name: 'Text',
        modelId: 'gpt-5.6-sol',
        apiKey: 'key',
        baseUrl: 'https://api.openai.com',
      }],
      defaults: { agent: 'txt-1' },
    });

    expect(hasConfiguredImageModel()).toBe(false);
    expect(hasConfiguredTextModel()).toBe(true);
    expect(hasAnyApiKey()).toBe(true);
  });

  it('keeps prompt optimize disabled by default', () => {
    expect(isPromptOptimizeEnabled()).toBe(false);
  });

  it('ignores and removes malformed localStorage JSON instead of breaking settings initialization', () => {
    storage.set('flyreq-model-registry', '{broken');

    expect(loadJsonFromStorage('flyreq-model-registry')).toEqual({});
    expect(storage.has('flyreq-model-registry')).toBe(false);
  });

  it('sets task-specific default models for image forms', () => {
    storage.set('flyreq-image-generation-settings', JSON.stringify({ outputSize: '2K' }));
    storage.set('flyreq-t2i-settings', JSON.stringify({ model: 'old-model', aspectRatio: '16:9' }));

    saveImageModelFormDefaults({
      textToImage: 'rkapi-4k-image',
      imageToImage: 'rkapi-reverse-image',
    });

    expect(JSON.parse(storage.get('flyreq-image-generation-settings') || '{}')).toEqual({
      model: 'rkapi-4k-image',
      outputSize: '2K',
    });
    expect(JSON.parse(storage.get('flyreq-t2i-settings') || '{}')).toEqual({
      model: 'rkapi-4k-image',
      aspectRatio: '16:9',
    });
    expect(JSON.parse(storage.get('flyreq-i2i-settings') || '{}')).toEqual({
      model: 'rkapi-reverse-image',
    });
  });

  it('migrates stale RKAPI image-to-image form defaults once', () => {
    writeRegistry({
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
      defaults: { textToImage: 'rkapi-4k-image', imageToImage: 'rkapi-4k-image' },
    });
    storage.set('flyreq-i2i-settings', JSON.stringify({ model: 'rkapi-4k-image', aspectRatio: '1:1' }));

    migrateRkapiImageFormDefaults();

    expect(loadRegistry().defaults).toMatchObject({
      textToImage: 'rkapi-4k-image',
      imageToImage: 'rkapi-reverse-image',
    });
    expect(JSON.parse(storage.get('flyreq-i2i-settings') || '{}')).toEqual({
      model: 'rkapi-reverse-image',
      aspectRatio: '1:1',
    });

    storage.set('flyreq-i2i-settings', JSON.stringify({ model: 'rkapi-4k-image' }));
    migrateRkapiImageFormDefaults();
    expect(JSON.parse(storage.get('flyreq-i2i-settings') || '{}')).toEqual({
      model: 'rkapi-4k-image',
    });
  });

  it('persists RKAPI text model edits before an API key is filled', () => {
    const textModels = [
      {
        id: 'rkapi-text',
        protocol: 'openai' as const,
        name: 'RKAPI',
        modelId: 'custom-text-model',
        apiKey: '',
        baseUrl: 'https://api.rkai6.com',
      },
      {
        id: 'empty-extra',
        protocol: 'openai' as const,
        name: 'RKAPI',
        modelId: '',
        apiKey: '',
        baseUrl: 'https://api.rkai6.com',
      },
    ];

    expect(getPersistableTextModelsForSettingsSave(textModels)).toEqual([textModels[0]]);
    expect(getEnabledTextModelsForSettingsSave(textModels)).toEqual([]);
  });

  it('allows saving a complete RKAPI text model before image model API keys are filled', () => {
    const imageModels = loadRegistry().imageModels;
    const enabledTextModels = [{
      id: 'rkapi-text',
      protocol: 'openai' as const,
      name: 'RKAPI',
      modelId: 'gpt-5.6-sol',
      apiKey: 'text-key',
      baseUrl: 'https://api.rkai6.com',
    }];

    expect(getSettingsModelSaveError({
      imageModels,
      enabledTextModels,
      promptOptimizeEnabled: false,
    })).toBeNull();
    expect(getSettingsModelSaveError({
      imageModels,
      enabledTextModels: [],
      promptOptimizeEnabled: false,
    })).toBe('至少完成一个图片模型或文本模型的全部信息');
  });

  it('ships RKAPI default image and text model drafts without unlocking workflows before keys are filled', () => {
    const registry = loadRegistry();
    expect(registry.imageModels).toHaveLength(2);
    expect(registry.imageModels[0]).toMatchObject({
      id: 'rkapi-reverse-image',
      protocol: 'openai',
      name: 'RKAPI-逆向',
      modelId: 'gpt-image-2',
      apiKey: '',
      baseUrl: 'https://api.rkai6.com',
      builtinPreset: 'gpt-image-2',
      maxRefImages: 16,
      maxOutputSize: '4K',
    });
    expect(registry.imageModels[1]).toMatchObject({
      id: 'rkapi-4k-image',
      protocol: 'openai',
      name: 'RKAPI-4k',
      modelId: 'gpt-image-2',
      apiKey: '',
      baseUrl: 'https://api.rkai6.com',
      builtinPreset: 'gpt-image-2',
      maxRefImages: 16,
      maxOutputSize: '4K',
    });
    expect(registry.textModels).toEqual([expect.objectContaining({
      id: 'rkapi-text',
      protocol: 'openai',
      name: 'RKAPI',
      modelId: 'gpt-5.6-sol',
      apiKey: '',
      baseUrl: 'https://api.rkai6.com',
    })]);
    expect(getResolvedImageModelId(registry.imageModels[0])).toBe('gpt-image-2');
    expect(getResolvedImageModelId(registry.imageModels[1])).toBe('gpt-image-2');
    expect(hasConfiguredImageModel()).toBe(false);
    expect(hasConfiguredTextModel()).toBe(false);
  });

  it('forces persisted model base URLs to the RKAPI gateway', () => {
    writeRegistry({
      imageModels: [{
        id: 'img-custom',
        protocol: 'openai',
        name: 'Custom Image',
        modelId: 'gpt-image-2',
        apiKey: 'key',
        baseUrl: 'https://api.openai.com',
        builtinPreset: 'gpt-image-2',
        maxRefImages: 16,
        maxOutputSize: '4K',
        supportsAdvancedParams: true,
      }],
      textModels: [{
        id: 'txt-custom',
        protocol: 'openai',
        name: 'Custom Text',
        modelId: 'gpt-5.6-sol',
        apiKey: 'key',
        baseUrl: 'https://api.openai.com',
      }],
      defaults: {
        textToImage: 'img-custom',
        imageToImage: 'img-custom',
        reversePrompt: 'txt-custom',
        agent: 'txt-custom',
        promptOptimize: 'txt-custom',
        imageDescribe: 'txt-custom',
      },
    });

    const registry = loadRegistry();
    expect(registry.imageModels[0].baseUrl).toBe('https://api.rkai6.com');
    expect(registry.textModels[0].baseUrl).toBe('https://api.rkai6.com');
  });

  it('migrates the legacy default image model into the RKAPI image pair', () => {
    writeRegistry({
      imageModels: [{
        id: 'flyreq-gpt-image-2',
        protocol: 'openai',
        name: 'Legacy Default',
        modelId: '',
        usesPresetModelId: true,
        apiKey: 'legacy-key',
        baseUrl: 'https://legacy.example.com',
        builtinPreset: 'gpt-image-2',
        maxRefImages: 8,
        maxOutputSize: '2K',
        supportsAdvancedParams: true,
        streamImages: true,
      }],
      textModels: [],
      defaults: {
        textToImage: 'flyreq-gpt-image-2',
        imageToImage: 'flyreq-gpt-image-2',
      },
    });

    const registry = loadRegistry();
    expect(registry.imageModels.some((model) => model.id === 'flyreq-gpt-image-2')).toBe(false);
    expect(registry.imageModels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'rkapi-reverse-image',
        name: 'RKAPI-逆向',
        modelId: 'gpt-image-2',
        apiKey: 'legacy-key',
        baseUrl: 'https://api.rkai6.com',
        maxRefImages: 8,
        maxOutputSize: '2K',
      }),
      expect.objectContaining({
        id: 'rkapi-4k-image',
        name: 'RKAPI-4k',
        modelId: 'gpt-image-2',
        apiKey: 'legacy-key',
        baseUrl: 'https://api.rkai6.com',
        maxRefImages: 8,
        maxOutputSize: '4K',
      }),
    ]));
    expect(registry.defaults).toMatchObject({
      textToImage: 'rkapi-4k-image',
      imageToImage: 'rkapi-reverse-image',
    });
  });

  it('checks model availability with a POST body instead of putting the API key in the URL', async () => {
    writeRegistry({
      imageModels: [{
        id: 'rkapi-4k-image',
        protocol: 'openai',
        name: 'RKAPI-4k',
        modelId: 'gpt-image-2',
        apiKey: 'secret-key',
        baseUrl: 'https://api.rkai6.com',
        builtinPreset: 'gpt-image-2',
        maxRefImages: 16,
        maxOutputSize: '4K',
        supportsAdvancedParams: true,
      }],
      textModels: [],
      defaults: { textToImage: 'rkapi-4k-image', imageToImage: 'rkapi-4k-image' },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ id: 'gpt-image-2' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkModelsAvailability(['rkapi-4k-image'])).resolves.toEqual([expect.objectContaining({
      modelId: 'rkapi-4k-image',
      available: true,
    })]);

    expect(fetchMock).toHaveBeenCalledWith('/api/flyreq/proxy/models', expect.objectContaining({
      method: 'POST',
      cache: 'no-store',
    }));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('apiKey');
    expect(JSON.parse(String(init.body))).toMatchObject({
      apiKey: 'secret-key',
      baseUrl: 'https://api.rkai6.com',
      protocol: 'openai',
    });
  });

  it('can check unsaved settings form model drafts directly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ id: 'draft-model' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkModelsAvailability(['draft-text'], [{
      id: 'draft-text',
      name: 'RKAPI',
      protocol: 'openai',
      baseUrl: 'https://api.rkai6.com',
      apiKey: 'draft-key',
      modelId: 'draft-model',
    }])).resolves.toEqual([expect.objectContaining({
      modelId: 'draft-text',
      available: true,
    })]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      apiKey: 'draft-key',
      baseUrl: 'https://api.rkai6.com',
      modelId: 'draft-model',
    });
  });

  it('uses gpt-image-2 when a GPT Image 2 configuration leaves its model ID blank', () => {
    writeRegistry({
      imageModels: [{
        id: 'img-gpt-image-2',
        protocol: 'openai',
        name: 'GPT Image 2',
        modelId: '  ',
        apiKey: 'key',
        baseUrl: 'https://api.openai.com',
        builtinPreset: 'gpt-image-2',
        maxRefImages: 16,
        maxOutputSize: '4K',
        supportsAdvancedParams: true,
      }],
      textModels: [],
      defaults: { textToImage: 'img-gpt-image-2', imageToImage: 'img-gpt-image-2' },
    });

    const [model] = loadRegistry().imageModels;
    expect(model).toMatchObject({ modelId: 'gpt-image-2' });
    expect(getResolvedImageModelId(model)).toBe('gpt-image-2');
    expect(resolveImageTaskProvider('img-gpt-image-2').modelId).toBe('gpt-image-2');
    expect(hasConfiguredImageModel()).toBe(true);
  });

  it('uses every built-in preset model ID when its configured model ID is blank', () => {
    const imageModels = Object.values(BUILTIN_IMAGE_PRESETS).map((preset) => ({
      id: `img-${preset.id}`, protocol: preset.protocol, name: preset.name, modelId: '',
      apiKey: 'key', baseUrl: preset.baseUrl, builtinPreset: preset.id,
      maxRefImages: preset.maxRefImages, maxOutputSize: preset.maxOutputSize,
      supportsAdvancedParams: preset.supportsAdvancedParams,
    }));
    writeRegistry({
      imageModels,
      textModels: [],
      defaults: { textToImage: imageModels[0].id, imageToImage: imageModels[0].id },
    });

    const registry = loadRegistry();
    for (const preset of Object.values(BUILTIN_IMAGE_PRESETS)) {
      const model = registry.imageModels.find((item) => item.builtinPreset === preset.id);
      expect(model).toMatchObject({ modelId: preset.modelId });
      expect(getResolvedImageModelId(model!)).toBe(preset.modelId);
      expect(resolveImageTaskProvider(`img-${preset.id}`).modelId).toBe(preset.modelId);
    }
    expect(hasConfiguredImageModel()).toBe(true);
  });

  it('does not turn a legacy OpenAI configuration without a preset into GPT Image 2', () => {
    writeRegistry({
      imageModels: [{
        id: 'img-legacy-openai',
        protocol: 'openai',
        name: 'Legacy OpenAI',
        modelId: '',
        apiKey: 'key',
        baseUrl: 'https://api.example.com',
        maxRefImages: 1,
        maxOutputSize: '1K',
        supportsAdvancedParams: false,
      }],
      textModels: [],
      defaults: { textToImage: 'img-legacy-openai', imageToImage: 'img-legacy-openai' },
    });

    const [model] = loadRegistry().imageModels;
    expect(getResolvedImageModelId(model)).toBe('');
    expect(hasConfiguredImageModel()).toBe(false);
  });

  it('normalizes legacy Grok configurations to its immutable API contract', () => {
    writeRegistry({
      imageModels: [{
        id: 'img-legacy-grok',
        protocol: 'google',
        name: 'Grok Imagine',
        modelId: 'grok-imagine-image',
        apiKey: 'key',
        baseUrl: 'https://api.x.ai',
        maxRefImages: 4,
        maxOutputSize: '4K',
        supportsAdvancedParams: true,
        streamImages: true,
      }],
      textModels: [],
      defaults: { textToImage: 'img-legacy-grok', imageToImage: 'img-legacy-grok' },
    });

    expect(loadRegistry().imageModels[0]).toMatchObject({
      protocol: 'openai',
      builtinPreset: 'grok-imagine-image',
      maxRefImages: 1,
      maxOutputSize: '2K',
      supportsAdvancedParams: false,
      streamImages: false,
    });
  });

  it('blocks prompt optimize when no complete text model exists', () => {
    writeRegistry({
      imageModels: [],
      textModels: [],
      defaults: {},
    });

    expect(canEnablePromptOptimize()).toBe(false);
    expect(setPromptOptimizeEnabled(true)).toBe(false);
    expect(isPromptOptimizeEnabled()).toBe(false);
  });

  it('allows prompt optimize when a complete text model exists', () => {
    writeRegistry({
      imageModels: [],
      textModels: [{
        id: 'txt-1',
        protocol: 'openai',
        name: 'Text',
        modelId: 'gpt-5.6-sol',
        apiKey: 'key',
        baseUrl: 'https://api.openai.com',
      }],
      defaults: { promptOptimize: 'txt-1' },
    });

    expect(canEnablePromptOptimize()).toBe(true);
    expect(setPromptOptimizeEnabled(true)).toBe(true);
    expect(isPromptOptimizeEnabled()).toBe(true);
  });
});

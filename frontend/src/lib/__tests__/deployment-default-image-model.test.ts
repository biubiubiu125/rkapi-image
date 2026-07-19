import { afterEach, describe, expect, it } from 'vitest';
import {
  applyDeploymentDefaultImageModel,
  loadRegistry,
  saveRegistry,
} from '@/lib/flyreq-models';

describe('deployment default image model config', () => {
  afterEach(() => {
    localStorage.clear();
    applyDeploymentDefaultImageModel();
  });

  it('applies two RKAPI default image models when no local registry exists', () => {
    applyDeploymentDefaultImageModel({
      id: 'deployment-image',
      protocol: 'openai',
      name: 'Deployment Image',
      modelId: 'deployment-model',
      usesPresetModelId: false,
      baseUrl: 'https://images.example.com',
      builtinPreset: 'gpt-image-2',
      maxRefImages: 8,
      maxOutputSize: '2K',
      supportsAdvancedParams: true,
      supportsTemperature: false,
      streamImages: true,
    });

    const registry = loadRegistry();
    expect(registry.imageModels).toEqual([
      expect.objectContaining({
        id: 'rkapi-reverse-image',
        name: 'RKAPI-逆向',
        modelId: 'deployment-model',
        baseUrl: 'https://api.rkai6.com',
        maxOutputSize: '2K',
        streamImages: true,
      }),
      expect.objectContaining({
        id: 'rkapi-4k-image',
        name: 'RKAPI-4k',
        modelId: 'deployment-model',
        baseUrl: 'https://api.rkai6.com',
        maxOutputSize: '4K',
        streamImages: true,
      }),
    ]);
  });

  it('provides an RKAPI text model draft when no local registry exists', () => {
    const registry = loadRegistry();
    expect(registry.textModels).toEqual([expect.objectContaining({
      id: 'rkapi-text',
      name: 'RKAPI',
      modelId: 'gpt-5.6-sol',
      baseUrl: 'https://api.rkai6.com',
    })]);
  });

  it('keeps a saved user image model and appends the RKAPI default image pair', () => {
    saveRegistry({
      imageModels: [{
        id: 'user-image',
        protocol: 'openai',
        name: 'User Image',
        modelId: 'user-model',
        apiKey: 'user-key',
        baseUrl: 'https://user.example.com',
        builtinPreset: 'gpt-image-2',
        maxRefImages: 4,
        maxOutputSize: '1K',
        supportsAdvancedParams: false,
        supportsTemperature: false,
        streamImages: false,
      }],
      textModels: [],
      defaults: {
        textToImage: 'user-image',
        imageToImage: 'user-image',
        reversePrompt: '',
        agent: '',
        promptOptimize: '',
        imageDescribe: '',
      },
    });
    applyDeploymentDefaultImageModel({ id: 'deployment-image', name: 'Deployment Image' });

    const registry = loadRegistry();
    expect(registry.imageModels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'user-image',
        name: 'RKAPI',
        baseUrl: 'https://api.rkai6.com',
        streamImages: false,
      }),
      expect.objectContaining({ id: 'rkapi-reverse-image', baseUrl: 'https://api.rkai6.com' }),
      expect.objectContaining({ id: 'rkapi-4k-image', baseUrl: 'https://api.rkai6.com' }),
    ]));
  });

  it('fixes saved text models to the RKAPI gateway and keeps the default RKAPI text draft', () => {
    saveRegistry({
      imageModels: [{
        id: 'user-image',
        protocol: 'openai',
        name: 'User Image',
        modelId: 'user-model',
        apiKey: 'user-key',
        baseUrl: 'https://user.example.com',
        builtinPreset: 'gpt-image-2',
        maxRefImages: 4,
        maxOutputSize: '1K',
        supportsAdvancedParams: false,
        supportsTemperature: false,
        streamImages: false,
      }],
      textModels: [{
        id: 'user-text',
        protocol: 'openai',
        name: 'User Text',
        modelId: 'gpt-5.6-sol',
        apiKey: 'text-key',
        baseUrl: 'https://text.example.com',
      }],
      defaults: {
        textToImage: 'user-image',
        imageToImage: 'user-image',
        reversePrompt: 'user-text',
        agent: 'user-text',
        promptOptimize: 'user-text',
        imageDescribe: 'user-text',
      },
    });

    expect(loadRegistry().textModels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'user-text',
        name: 'RKAPI',
        baseUrl: 'https://api.rkai6.com',
      }),
      expect.objectContaining({
        id: 'rkapi-text',
        name: 'RKAPI',
        baseUrl: 'https://api.rkai6.com',
      }),
    ]));
  });

  it('does not overwrite saved user image model capability flags', () => {
    saveRegistry({
      imageModels: [{
        id: 'user-image',
        protocol: 'openai',
        name: 'User Image',
        modelId: 'user-model',
        apiKey: 'user-key',
        baseUrl: 'https://user.example.com',
        builtinPreset: 'gpt-image-2',
        maxRefImages: 4,
        maxOutputSize: '1K',
        supportsAdvancedParams: false,
        supportsTemperature: false,
        streamImages: true,
      }],
      textModels: [],
      defaults: {
        textToImage: 'user-image',
        imageToImage: 'user-image',
        reversePrompt: '',
        agent: '',
        promptOptimize: '',
        imageDescribe: '',
      },
    });
    applyDeploymentDefaultImageModel({ id: 'deployment-image', name: 'Deployment Image' });

    expect(loadRegistry().imageModels).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'user-image',
      streamImages: true,
    })]));
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import {
  applyDeploymentDefaultImageModel,
  loadRegistry,
  saveRegistry,
} from '@/lib/flyreq-models';

describe('部署级首次图片模型配置', () => {
  afterEach(() => {
    localStorage.clear();
    applyDeploymentDefaultImageModel();
  });

  it('在没有本地注册表时应用部署级默认模型并默认开启流式请求', () => {
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
    expect(registry.imageModels).toEqual([expect.objectContaining({
      id: 'deployment-image',
      name: 'Deployment Image',
      modelId: 'deployment-model',
      baseUrl: 'https://images.example.com',
      streamImages: true,
    })]);
  });

  it('不覆盖用户已经保存的图片模型配置', () => {
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

    expect(loadRegistry().imageModels).toEqual([expect.objectContaining({
      id: 'user-image',
      name: 'User Image',
      streamImages: false,
    })]);
  });
});

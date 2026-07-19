import { describe, expect, it } from 'vitest';
import {
  getCleanUrlAfterExternalModelConfig,
  getExternalImageModelMatch,
  parseExternalModelConfig,
} from '@/lib/external-model-config';
import type { ImageModelConfig } from '@/lib/flyreq-models';

describe('external model config URL parser', () => {
  it('parses image model config from a single provider JSON parameter', () => {
    const provider = encodeURIComponent(JSON.stringify({
      type: 'image',
      preset: 'gpt-image-2',
      provider: 'openai',
      modelKey: 'rkapi-4k-image',
      name: 'RKAPI-4k',
      modelId: 'gpt-image-2',
      baseUrl: 'https://api.rkai6.com',
      apiKey: 'json-key',
      maxRefImages: 16,
      maxOutputSize: '4K',
    }));
    const url = new URL(`https://example.com/zh/?provider=${provider}`);

    expect(parseExternalModelConfig(url)).toMatchObject({
      type: 'image',
      preset: 'gpt-image-2',
      protocol: 'openai',
      modelKey: 'rkapi-4k-image',
      name: 'RKAPI-4k',
      modelId: 'gpt-image-2',
      baseUrl: 'https://api.rkai6.com',
      maxRefImages: 16,
      maxOutputSize: '4K',
    });
    expect(parseExternalModelConfig(url)).not.toHaveProperty('apiKey');
  });

  it('also accepts raw JSON in the provider parameter', () => {
    const url = new URL('https://example.com/zh/?provider={"type":"image","preset":"gpt-image-2","provider":"openai","name":"RKAPI-4k","modelId":"gpt-image-2","baseUrl":"https://api.rkai6.com","apiKey":"raw-key"}');

    expect(parseExternalModelConfig(url)).toMatchObject({
      type: 'image',
      preset: 'gpt-image-2',
      protocol: 'openai',
      name: 'RKAPI-4k',
      modelId: 'gpt-image-2',
      baseUrl: 'https://api.rkai6.com',
    });
    expect(parseExternalModelConfig(url)).not.toHaveProperty('apiKey');
  });

  it('parses Gemini temperature capability and the Lite preset from a provider URL', () => {
    const provider = encodeURIComponent(JSON.stringify({
      type: 'image',
      preset: 'gemini-3.1-flash-lite-image',
      provider: 'google',
      modelId: 'gemini-3.1-flash-lite-image',
      supportsTemperature: false,
    }));
    const url = new URL(`https://example.com/zh/?provider=${provider}`);

    expect(parseExternalModelConfig(url)).toMatchObject({
      preset: 'gemini-3.1-flash-lite-image',
      protocol: 'google',
      supportsTemperature: false,
    });
  });

  it('removes external config params and hash from URL', () => {
    const provider = encodeURIComponent(JSON.stringify({ type: 'image', name: 'RKAPI-4k', apiKey: 'secret' }));
    const url = new URL(`https://example.com/zh/?provider=${provider}&keep=1#debug`);

    expect(getCleanUrlAfterExternalModelConfig(url)).toBe('/zh/?keep=1');
  });

  it('keeps legacy multi-param URLs parseable without importing API keys', () => {
    const url = new URL('https://example.com/zh/?configureModel=1&type=image&preset=gpt-image-2&protocol=openai&name=RKAPI-4k&modelId=gpt-image-2&baseUrl=https%3A%2F%2Fapi.rkai6.com&apiKey=query-key&maxRefImages=16&maxOutputSize=4K');

    expect(parseExternalModelConfig(url)).toMatchObject({
      type: 'image',
      protocol: 'openai',
      maxOutputSize: '4K',
    });
    expect(parseExternalModelConfig(url)).not.toHaveProperty('apiKey');
  });

  it('removes legacy multi-param config values and API keys from URL', () => {
    const url = new URL('https://example.com/zh/?configureModel=1&type=image&preset=gpt-image-2&protocol=openai&name=RKAPI-4k&modelId=gpt-image-2&baseUrl=https%3A%2F%2Fapi.rkai6.com&apiKey=query-key&maxRefImages=16&maxOutputSize=4K&keep=1#debug');

    expect(getCleanUrlAfterExternalModelConfig(url)).toBe('/zh/?keep=1');
  });

  it('matches existing image model by stable key or model ID without requiring base URL', () => {
    const models: ImageModelConfig[] = [{
      id: 'rkapi-4k-image',
      protocol: 'openai',
      name: 'RKAPI-4k',
      modelId: 'gpt-image-2',
      apiKey: '',
      baseUrl: 'https://api.rkai6.com/',
      builtinPreset: 'gpt-image-2',
      maxRefImages: 16,
      maxOutputSize: '4K',
      supportsAdvancedParams: true,
    }];

    expect(getExternalImageModelMatch(models, {
      type: 'image',
      protocol: 'openai',
      modelId: 'gpt-image-2',
    })?.id).toBe('rkapi-4k-image');
  });

  it('uses RKAPI display name to disambiguate identical default image model IDs', () => {
    const models: ImageModelConfig[] = [
      {
        id: 'rkapi-reverse-image',
        protocol: 'openai',
        name: 'RKAPI-逆向',
        modelId: 'gpt-image-2',
        apiKey: '',
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
        apiKey: '',
        baseUrl: 'https://api.rkai6.com',
        builtinPreset: 'gpt-image-2',
        maxRefImages: 16,
        maxOutputSize: '4K',
        supportsAdvancedParams: true,
      },
    ];

    expect(getExternalImageModelMatch(models, {
      type: 'image',
      protocol: 'openai',
      name: 'RKAPI-4k',
      modelId: 'gpt-image-2',
    })?.id).toBe('rkapi-4k-image');
  });

  it('prefers RKAPI-4k for legacy GPT Image 2 links without a model key or display name', () => {
    const models: ImageModelConfig[] = [
      {
        id: 'rkapi-reverse-image',
        protocol: 'openai',
        name: 'RKAPI-逆向',
        modelId: 'gpt-image-2',
        apiKey: '',
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
        apiKey: '',
        baseUrl: 'https://api.rkai6.com',
        builtinPreset: 'gpt-image-2',
        maxRefImages: 16,
        maxOutputSize: '4K',
        supportsAdvancedParams: true,
      },
    ];

    expect(getExternalImageModelMatch(models, {
      type: 'image',
      protocol: 'openai',
      modelId: 'gpt-image-2',
    })?.id).toBe('rkapi-4k-image');
  });
});

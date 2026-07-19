import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkModelsAvailability } from '@/lib/flyreq-task-client';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(
  path.resolve(testDir, '../../../../backend/server.js'),
  'utf8',
);

describe('google model availability chain', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not force Google model checks through the OpenAI-style /v1/models path', () => {
    expect(serverSource).not.toContain("const modelsUrl = `${stripProtocolVersionSuffix(protocol, normalizedBaseUrl)}/v1/models`");
    expect(serverSource).toContain("protocol === 'google'");
    expect(serverSource).toContain('/v1beta/models/');
  });

  it('accepts the Google single-model proxy response as available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      name: 'models/gemini-3-pro-image-preview',
      displayName: 'Gemini 3 Pro Image Preview',
    }), { status: 200 })));

    const [status] = await checkModelsAvailability(undefined, [{
      id: 'google-image',
      name: 'Google Image',
      protocol: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'test-key',
      modelId: 'gemini-3-pro-image-preview',
    }]);

    expect(status).toEqual(expect.objectContaining({
      modelId: 'google-image',
      available: true,
      message: 'gemini-3-pro-image-preview',
    }));
  });

  it('passes an abort signal to model availability proxy checks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'gpt-image-2' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await checkModelsAvailability(undefined, [{
      id: 'rkapi-4k-image',
      name: 'RKAPI-4k',
      protocol: 'openai',
      baseUrl: 'https://api.rkai6.com',
      apiKey: 'test-key',
      modelId: 'gpt-image-2',
    }]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createXaiImagineRequestInit, getXaiImagineEndpoint } = require(
  path.resolve(testDir, '../../../../backend/xai-imagine.js'),
);

describe('xAI Imagine request adapter', () => {
  it('builds a JSON text-to-image request with xAI fields', () => {
    const init = createXaiImagineRequestInit('xai-key', {
      mode: 'text-to-image',
      model: 'grok-imagine-image',
      prompt: 'A neon city at night',
      outputSize: '2K',
      aspectRatio: '19.5:9',
      images: [],
    });

    expect(getXaiImagineEndpoint('text-to-image')).toBe('/v1/images/generations');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers.Authorization).toBe('Bearer xai-key');
    expect(JSON.parse(init.body)).toEqual({
      model: 'grok-imagine-image',
      prompt: 'A neon city at night',
      n: 1,
      aspect_ratio: '19.5:9',
      resolution: '2k',
    });
  });

  it('builds a JSON image edit request without multipart fields', () => {
    const init = createXaiImagineRequestInit('xai-key', {
      mode: 'image-to-image',
      model: 'grok-imagine-image-quality',
      prompt: 'Turn this into a watercolor painting',
      outputSize: '1K',
      aspectRatio: '1:1',
      images: [{ data: 'ZmFrZS1pbWFnZQ==', mimeType: 'image/jpeg' }],
    });

    expect(getXaiImagineEndpoint('image-to-image')).toBe('/v1/images/edits');
    expect(init.body).not.toContain('FormData');
    expect(JSON.parse(init.body)).toEqual({
      model: 'grok-imagine-image-quality',
      prompt: 'Turn this into a watercolor painting',
      n: 1,
      aspect_ratio: '1:1',
      resolution: '1k',
      image: {
        type: 'image_url',
        url: 'data:image/jpeg;base64,ZmFrZS1pbWFnZQ==',
      },
    });
  });
});

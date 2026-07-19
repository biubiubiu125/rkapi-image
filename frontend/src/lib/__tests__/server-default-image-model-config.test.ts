import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(
  path.resolve(testDir, '../../../../backend/server.js'),
  'utf8',
);
const backendEnvExample = fs.readFileSync(
  path.resolve(testDir, '../../../../backend/.env.example'),
  'utf8',
);
const readmeSource = fs.readFileSync(
  path.resolve(testDir, '../../../../README.md'),
  'utf8',
);

describe('backend deployment default image model config', () => {
  it('reads the full default image model through prefixed runtime env aliases and exposes it through config', () => {
    expect(serverSource).toContain('function resolveDefaultImageModelConfig(env = getRuntimeEnv())');
    expect(serverSource).toContain("name: DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.name");
    expect(serverSource).toContain("baseUrl: DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.baseUrl");
    expect(serverSource).toContain("modelId: 'gpt-image-2'");
    expect(serverSource).toContain("getRuntimeEnvValue(env, 'DEFAULT_IMAGE_MODEL_STREAM_IMAGES')");
    expect(serverSource).toContain("getRuntimeEnvValue(env, 'DEFAULT_IMAGE_MODEL_MODEL_ID')");
    expect(serverSource).toContain('defaultImageModel: resolveDefaultImageModelConfig(env)');
  });

  it('does not expose ignored deployment default key, name, or output-size env options', () => {
    expect(serverSource).not.toContain("getRuntimeEnvValue(env, 'DEFAULT_IMAGE_MODEL_KEY')");
    expect(serverSource).not.toContain("getRuntimeEnvValue(env, 'DEFAULT_IMAGE_MODEL_NAME')");
    expect(serverSource).not.toContain("getRuntimeEnvValue(env, 'DEFAULT_IMAGE_MODEL_MAX_OUTPUT_SIZE')");
    expect(backendEnvExample).not.toContain('RKAPI_IMAGE_DEFAULT_IMAGE_MODEL_KEY');
    expect(backendEnvExample).not.toContain('RKAPI_IMAGE_DEFAULT_IMAGE_MODEL_NAME');
    expect(backendEnvExample).not.toContain('RKAPI_IMAGE_DEFAULT_IMAGE_MODEL_MAX_OUTPUT_SIZE');
    expect(readmeSource).not.toContain('RKAPI_IMAGE_DEFAULT_IMAGE_MODEL_KEY');
    expect(readmeSource).not.toContain('RKAPI_IMAGE_DEFAULT_IMAGE_MODEL_NAME');
    expect(readmeSource).not.toContain('RKAPI_IMAGE_DEFAULT_IMAGE_MODEL_MAX_OUTPUT_SIZE');
  });
});

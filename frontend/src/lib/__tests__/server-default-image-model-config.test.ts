import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(
  path.resolve(testDir, '../../../../backend/server.js'),
  'utf8',
);

describe('后端部署级首次图片模型配置', () => {
  it('读取完整默认模型环境变量并通过配置接口下发', () => {
    expect(serverSource).toContain('function resolveDefaultImageModelConfig(env = getRuntimeEnv())');
    expect(serverSource).toContain('FLYREQ_DEFAULT_IMAGE_MODEL_NAME');
    expect(serverSource).toContain('FLYREQ_DEFAULT_IMAGE_MODEL_STREAM_IMAGES');
    expect(serverSource).toContain('defaultImageModel: resolveDefaultImageModelConfig(env)');
  });
});

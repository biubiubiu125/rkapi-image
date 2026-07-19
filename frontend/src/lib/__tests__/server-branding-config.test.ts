import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(
  path.resolve(testDir, '../../../../backend/server.js'),
  'utf8',
);

describe('backend platform branding config', () => {
  it('reads platform name, logo, and icon through prefixed runtime env aliases', () => {
    expect(serverSource).toContain('function getRuntimeEnvValue(env, key)');
    expect(serverSource).toContain('env[`RKAPI_IMAGE_${key}`]');
    expect(serverSource).toContain('env[`FLYREQ_${key}`]');
    expect(serverSource).toContain("getRuntimeEnvValue(env, 'PLATFORM_NAME')");
    expect(serverSource).toContain("getRuntimeEnvValue(env, 'PLATFORM_LOGO_URL')");
    expect(serverSource).toContain("getRuntimeEnvValue(env, 'PLATFORM_ICON_URL')");
    expect(serverSource).toContain('process.env.APP_VERSION');
    expect(serverSource).toContain('function resolvePlatformBranding(env = getRuntimeEnv())');
  });

  it('exposes branding to the frontend config and dynamic PWA manifest', () => {
    expect(serverSource).toContain('branding: resolvePlatformBranding(env)');
    expect(serverSource).toContain("'/api/flyreq/manifest.webmanifest'");
    expect(serverSource).toContain('buildPlatformManifest(resolvePlatformBranding(getRuntimeEnv()))');
  });
});

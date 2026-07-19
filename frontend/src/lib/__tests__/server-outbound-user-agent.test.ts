import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(
  path.resolve(testDir, '../../../../backend/server.js'),
  'utf8',
);

/**
 * 从后端源码加载出站 User-Agent 辅助函数，避免启动 HTTP 服务和数据库。
 * @returns 用于解析和合并出站 User-Agent 的函数集合。
 */
function loadOutboundUserAgentHelpers(): {
  resolveOutboundUserAgent: (env: Record<string, string>) => string;
  createOutboundHeaders: (headers: HeadersInit | undefined, env: Record<string, string>) => Headers;
} {
  const defaultConstantStart = serverSource.indexOf('const DEFAULT_OUTBOUND_USER_AGENT');
  const start = serverSource.indexOf('function resolveOutboundUserAgent');
  const end = serverSource.indexOf('function parseBaseUrlRewriteMap');
  const defaultConstantEnd = serverSource.indexOf('\n', defaultConstantStart);
  if (defaultConstantStart < 0 || defaultConstantEnd < 0 || start < 0 || end < 0 || end <= start) {
    throw new Error('Unable to locate outbound User-Agent helpers in backend/server.js');
  }

  const defaultConstant = serverSource.slice(defaultConstantStart, defaultConstantEnd);
  const envHelper = `
function getRuntimeEnvValue(env, key) {
  const currentValue = env['RKAPI_IMAGE_' + key];
  if (currentValue !== undefined && String(currentValue).trim() !== '') return currentValue;
  return env['FLYREQ_' + key];
}`;
  const source = `${envHelper}\n${defaultConstant}\n${serverSource.slice(start, end)}\nreturn { resolveOutboundUserAgent, createOutboundHeaders };`;
  return new Function(source)() as {
    resolveOutboundUserAgent: (env: Record<string, string>) => string;
    createOutboundHeaders: (headers: HeadersInit | undefined, env: Record<string, string>) => Headers;
  };
}

describe('backend outbound User-Agent', () => {
  const { resolveOutboundUserAgent, createOutboundHeaders } = loadOutboundUserAgentHelpers();

  it('uses the stable product identifier when no environment override exists', () => {
    expect(resolveOutboundUserAgent({})).toBe('RKAPI-Image/1.5.1');
  });

  it('uses the configured product identifier and removes HTTP control characters', () => {
    expect(resolveOutboundUserAgent({
      RKAPI_IMAGE_OUTBOUND_USER_AGENT: 'Example Studio/1.0\r\n\u0000Client',
    })).toBe('Example Studio/1.0   Client');
  });

  it('keeps legacy environment names as a fallback', () => {
    expect(resolveOutboundUserAgent({
      FLYREQ_OUTBOUND_USER_AGENT: 'Legacy Studio/1.0',
    })).toBe('Legacy Studio/1.0');
  });

  it('prefers RKAPI Image environment names over legacy names', () => {
    expect(resolveOutboundUserAgent({
      RKAPI_IMAGE_OUTBOUND_USER_AGENT: 'RKAPI Image/1.0',
      FLYREQ_OUTBOUND_USER_AGENT: 'Legacy Studio/1.0',
    })).toBe('RKAPI Image/1.0');
  });

  it('adds the configured User-Agent without discarding authentication headers', () => {
    const headers = createOutboundHeaders(
      { Authorization: 'Bearer test-key' },
      { RKAPI_IMAGE_OUTBOUND_USER_AGENT: 'Example Studio/1.0' },
    );

    expect(headers.get('authorization')).toBe('Bearer test-key');
    expect(headers.get('user-agent')).toBe('Example Studio/1.0');
  });

  it('keeps an explicitly supplied User-Agent unchanged', () => {
    const headers = createOutboundHeaders(
      { 'User-Agent': 'Explicit Client/2.0' },
      { RKAPI_IMAGE_OUTBOUND_USER_AGENT: 'Example Studio/1.0' },
    );

    expect(headers.get('user-agent')).toBe('Explicit Client/2.0');
  });
});

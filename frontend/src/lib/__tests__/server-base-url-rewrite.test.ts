import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(
  path.resolve(testDir, '../../../../backend/server.js'),
  'utf8',
);

type MockRequest = {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
};

function loadRewriteHelpers(): {
  resolveOutboundBaseUrl: (protocol: string, baseUrl: string, env: Record<string, string>) => string;
  appendProtocolApiPath: (protocol: string, baseUrl: string, apiPath: string) => string;
  shouldAuthorizeRemoteImageDownload: (imageUrl: string, request: { protocol: string; baseUrl: string }, env?: Record<string, string>) => boolean;
  resolveOutboundBaseUrlDetails: (protocol: string, baseUrl: string, env: Record<string, string>) => {
    baseUrl: string;
    originalBaseUrl: string;
    rewritten: boolean;
    rewriteCount: number;
  };
  resolveAndLogOutboundBaseUrl: (requestType: string, protocol: string, baseUrl: string, env: Record<string, string>) => {
    baseUrl: string;
    originalBaseUrl: string;
    rewritten: boolean;
    rewriteCount: number;
  };
  resolveFixedRkapiGatewayBaseUrl: (protocol?: string, baseUrl?: string) => string;
} {
  const start = serverSource.indexOf('function normalizeBaseUrl');
  const end = serverSource.indexOf('function resolveImageModelKeyGuide');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Unable to locate Base URL rewrite helpers in backend/server.js');
  }

  const envHelper = `
function getRuntimeEnvValue(env, key) {
  const currentValue = env['RKAPI_IMAGE_' + key];
  if (currentValue !== undefined && String(currentValue).trim() !== '') return currentValue;
  return env['FLYREQ_' + key];
}`;
  const source = `${envHelper}\nconst RKAPI_GATEWAY_BASE_URL = 'https://api.rkai6.com';\n${serverSource.slice(start, end)}\nreturn { resolveOutboundBaseUrl, resolveOutboundBaseUrlDetails, resolveAndLogOutboundBaseUrl, appendProtocolApiPath, shouldAuthorizeRemoteImageDownload, resolveFixedRkapiGatewayBaseUrl };`;
  return new Function(source)() as {
    resolveOutboundBaseUrl: (protocol: string, baseUrl: string, env: Record<string, string>) => string;
    appendProtocolApiPath: (protocol: string, baseUrl: string, apiPath: string) => string;
    shouldAuthorizeRemoteImageDownload: (imageUrl: string, request: { protocol: string; baseUrl: string }, env?: Record<string, string>) => boolean;
    resolveOutboundBaseUrlDetails: (protocol: string, baseUrl: string, env: Record<string, string>) => {
      baseUrl: string;
      originalBaseUrl: string;
      rewritten: boolean;
      rewriteCount: number;
    };
    resolveAndLogOutboundBaseUrl: (requestType: string, protocol: string, baseUrl: string, env: Record<string, string>) => {
      baseUrl: string;
      originalBaseUrl: string;
      rewritten: boolean;
      rewriteCount: number;
    };
    resolveFixedRkapiGatewayBaseUrl: (protocol?: string, baseUrl?: string) => string;
  };
}

function loadClientIpHelper(): {
  getClientIp: (req: MockRequest, env?: Record<string, string>) => string;
} {
  const start = serverSource.indexOf('function normalizeIp');
  const end = serverSource.indexOf('function hashApiKey');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Unable to locate client IP trust helpers in backend/server.js');
  }

  const envHelper = `
function getRuntimeEnvValue(env, key) {
  const currentValue = env['RKAPI_IMAGE_' + key];
  if (currentValue !== undefined && String(currentValue).trim() !== '') return currentValue;
  return env['FLYREQ_' + key];
}`;
  const source = `${envHelper}\n${serverSource.slice(start, end)}\nreturn { getClientIp };`;
  return new Function(source)() as {
    getClientIp: (req: MockRequest, env?: Record<string, string>) => string;
  };
}

describe('backend Base URL rewrite map', () => {
  const {
    resolveOutboundBaseUrl,
    resolveOutboundBaseUrlDetails,
    resolveAndLogOutboundBaseUrl,
    appendProtocolApiPath,
    shouldAuthorizeRemoteImageDownload,
    resolveFixedRkapiGatewayBaseUrl,
  } = loadRewriteHelpers();

  it('rewrites public OpenAI-compatible URLs to Docker internal URLs', () => {
    const env = {
      RKAPI_IMAGE_BASE_URL_REWRITE_MAP: '{"https://api.rkai6.com":"http://new-api:3000"}',
    };

    expect(resolveOutboundBaseUrl('openai', 'https://api.rkai6.com', env)).toBe('http://new-api:3000');
    expect(resolveOutboundBaseUrl('openai', 'https://api.rkai6.com/v1', env)).toBe('http://new-api:3000/v1');
  });

  it('supports multiple mappings', () => {
    const env = {
      RKAPI_IMAGE_BASE_URL_REWRITE_MAP: '{"https://api.rkai6.com":"http://new-api:3000","https://api.example.com":"http://example-new-api:3000"}',
    };

    expect(resolveOutboundBaseUrl('openai', 'https://api.example.com', env)).toBe('http://example-new-api:3000');
  });

  it('keeps legacy environment names as a fallback', () => {
    const env = {
      FLYREQ_BASE_URL_REWRITE_MAP: '{"https://api.rkai6.com":"http://legacy-new-api:3000"}',
    };

    expect(resolveOutboundBaseUrl('openai', 'https://api.rkai6.com', env)).toBe('http://legacy-new-api:3000');
  });

  it('prefers RKAPI Image environment names over legacy names', () => {
    const env = {
      RKAPI_IMAGE_BASE_URL_REWRITE_MAP: '{"https://api.rkai6.com":"http://new-api:3000"}',
      FLYREQ_BASE_URL_REWRITE_MAP: '{"https://api.rkai6.com":"http://legacy-new-api:3000"}',
    };

    expect(resolveOutboundBaseUrl('openai', 'https://api.rkai6.com', env)).toBe('http://new-api:3000');
  });

  it('keeps the original URL when no mapping matches', () => {
    const env = {
      RKAPI_IMAGE_BASE_URL_REWRITE_MAP: '{"https://api.rkai6.com":"http://new-api:3000"}',
    };

    expect(resolveOutboundBaseUrl('openai', 'https://other.example.com/v1', env)).toBe('https://other.example.com/v1');
  });

  it('forces caller supplied API base URLs back to the RKAPI gateway', () => {
    expect(resolveFixedRkapiGatewayBaseUrl('openai', 'https://other.example.com/v1')).toBe('https://api.rkai6.com');
    expect(resolveFixedRkapiGatewayBaseUrl('google', 'https://generativelanguage.googleapis.com/v1beta')).toBe('https://api.rkai6.com');
  });

  it('does not require caller supplied baseUrl after fixing requests to the RKAPI gateway', () => {
    expect(serverSource).toContain('body.baseUrl = resolveFixedRkapiGatewayBaseUrl()');
    expect(serverSource).not.toContain("throw new Error('缺少 API 基础地址')");
    expect(serverSource).not.toContain('Missing baseUrl or apiKey');
  });

  it('reports rewrite details for diagnostics', () => {
    const env = {
      RKAPI_IMAGE_BASE_URL_REWRITE_MAP: '{"https://api.rkai6.com":"http://new-api:3000"}',
    };

    expect(resolveOutboundBaseUrlDetails('openai', 'https://api.rkai6.com', env)).toEqual({
      baseUrl: 'http://new-api:3000',
      originalBaseUrl: 'https://api.rkai6.com',
      rewritten: true,
      rewriteCount: 1,
    });
    expect(resolveOutboundBaseUrlDetails('openai', 'https://api.rkai6.com/v1', env)).toEqual({
      baseUrl: 'http://new-api:3000/v1',
      originalBaseUrl: 'https://api.rkai6.com/v1',
      rewritten: true,
      rewriteCount: 1,
    });
  });

  it('logs rewrite diagnostics for both applied and unapplied mappings', () => {
    const env = {
      RKAPI_IMAGE_BASE_URL_REWRITE_MAP: '{"https://api.rkai6.com":"http://new-api:3000"}',
    };
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      expect(resolveAndLogOutboundBaseUrl('图片生成', 'openai', 'https://api.rkai6.com/v1', env)).toMatchObject({
        baseUrl: 'http://new-api:3000/v1',
        originalBaseUrl: 'https://api.rkai6.com/v1',
        rewritten: true,
      });
      expect(info).toHaveBeenCalledWith('[base-url-rewrite] 状态=已应用 请求=图片生成 协议=openai 原始Base URL=https://api.rkai6.com/v1 最终Base URL=http://new-api:3000/v1 映射规则数=1');

      resolveAndLogOutboundBaseUrl('图片生成', 'openai', 'https://other.example.com/v1', env);
      expect(info).toHaveBeenLastCalledWith('[base-url-rewrite] 状态=未命中 请求=图片生成 协议=openai 原始Base URL=https://other.example.com/v1 最终Base URL=https://other.example.com/v1 映射规则数=1');

      resolveAndLogOutboundBaseUrl('图片生成', 'openai', 'https://other.example.com/v1', {});
      expect(info).toHaveBeenLastCalledWith('[base-url-rewrite] 状态=未配置 请求=图片生成 协议=openai 原始Base URL=https://other.example.com/v1 最终Base URL=https://other.example.com/v1 映射规则数=0');
    } finally {
      info.mockRestore();
    }
  });

  it('does not duplicate protocol API prefixes when building URLs', () => {
    expect(appendProtocolApiPath('openai', 'http://new-api:3000', '/v1/images/generations')).toBe('http://new-api:3000/v1/images/generations');
    expect(appendProtocolApiPath('openai', 'http://new-api:3000/v1', '/v1/images/generations')).toBe('http://new-api:3000/v1/images/generations');
    expect(appendProtocolApiPath('google', 'http://new-api:3000/v1beta', '/v1beta/models/gemini:generateContent')).toBe('http://new-api:3000/v1beta/models/gemini:generateContent');
  });

  it('only authorizes remote image downloads for configured or rewritten API origins', () => {
    const env = {
      RKAPI_IMAGE_BASE_URL_REWRITE_MAP: '{"https://api.rkai6.com":"http://new-api:3000"}',
    };
    const request = { protocol: 'openai', baseUrl: 'https://api.rkai6.com/v1' };

    expect(shouldAuthorizeRemoteImageDownload('https://api.rkai6.com/v1/files/image-1', request, env)).toBe(true);
    expect(shouldAuthorizeRemoteImageDownload('http://new-api:3000/v1/files/image-1', request, env)).toBe(true);
    expect(shouldAuthorizeRemoteImageDownload('https://cdn.example.com/image-1.png', request, env)).toBe(false);
    expect(shouldAuthorizeRemoteImageDownload('https://other.example.com/v1/files/image-1', { protocol: 'openai', baseUrl: 'https://other.example.com/v1' }, env)).toBe(false);
  });
});

describe('backend client IP trust boundary', () => {
  const { getClientIp } = loadClientIpHelper();

  it('ignores spoofed forwarded headers when the remote proxy is not trusted', () => {
    expect(getClientIp({
      headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.8' },
      socket: { remoteAddress: '10.0.0.5' },
    }, {})).toBe('10.0.0.5');
  });

  it('uses the first forwarded IP only for a configured trusted proxy', () => {
    expect(getClientIp({
      headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.8' },
      socket: { remoteAddress: '::ffff:10.0.0.5' },
    }, { RKAPI_IMAGE_TRUSTED_PROXY_IPS: '10.0.0.5' })).toBe('203.0.113.10');
  });
});

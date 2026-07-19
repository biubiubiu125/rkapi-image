import fs from 'fs';
import net from 'node:net';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(
  path.resolve(testDir, '../../../../backend/server.js'),
  'utf8',
);

function loadPrivateIpHelper(): (address: string) => boolean {
  const start = serverSource.indexOf('function isPrivateIpv4');
  const end = serverSource.indexOf('async function resolveSafeRemoteImageDownloadTarget');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Unable to locate remote image IP helpers in backend/server.js');
  }

  const source = `${serverSource.slice(start, end)}\nreturn isPrivateIpAddress;`;
  return new Function('net', source)(net) as (address: string) => boolean;
}

function loadRemoteImageDownloadHelpers(): {
  resolveSafeRemoteImageDownloadTarget: (imageUrl: string) => Promise<{
    url: URL;
    hostname: string;
    address: string;
    family: 4 | 6;
  }>;
  createPinnedRemoteImageRequestOptions: (
    target: { url: URL; hostname: string; address: string; family: 4 | 6 },
    headers?: Record<string, string>,
  ) => { hostname: string; family: 4 | 6; headers: Record<string, string>; servername?: string };
} {
  const start = serverSource.indexOf('function isPrivateIpv4');
  const end = serverSource.indexOf('function getHeaderObject');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Unable to locate remote image download helpers in backend/server.js');
  }

  const fakeDns = {
    lookup: vi.fn(async () => ([
      { address: '93.184.216.34', family: 4 },
    ])),
  };
  const source = `${serverSource.slice(start, end)}\nreturn { resolveSafeRemoteImageDownloadTarget, createPinnedRemoteImageRequestOptions };`;
  return new Function('net', 'dns', source)(net, fakeDns) as ReturnType<typeof loadRemoteImageDownloadHelpers>;
}

describe('remote image SSRF guard', () => {
  const isPrivateIpAddress = loadPrivateIpHelper();

  it('blocks IPv4-mapped IPv6 private addresses written in hexadecimal form', () => {
    expect(isPrivateIpAddress('::ffff:7f00:1')).toBe(true);
    expect(isPrivateIpAddress('::ffff:a00:1')).toBe(true);
    expect(isPrivateIpAddress('64:ff9b::7f00:1')).toBe(true);
  });

  it('still allows public IPv4-mapped IPv6 addresses', () => {
    expect(isPrivateIpAddress('::ffff:808:808')).toBe(false);
  });

  it('pins the outbound request to the already-checked DNS address', async () => {
    const {
      resolveSafeRemoteImageDownloadTarget,
      createPinnedRemoteImageRequestOptions,
    } = loadRemoteImageDownloadHelpers();

    const target = await resolveSafeRemoteImageDownloadTarget('https://example.com/image.png?x=1');
    const requestOptions = createPinnedRemoteImageRequestOptions(target, { Accept: 'image/*' });

    expect(requestOptions.hostname).toBe('93.184.216.34');
    expect(requestOptions.family).toBe(4);
    expect(requestOptions.servername).toBe('example.com');
    expect(requestOptions.headers.Host).toBe('example.com');
    expect(requestOptions.headers.Accept).toBe('image/*');
  });

  it('rejects hostnames when any resolved address is private', async () => {
    const start = serverSource.indexOf('function isPrivateIpv4');
    const end = serverSource.indexOf('function getHeaderObject');
    const fakeDns = {
      lookup: vi.fn(async () => ([
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ])),
    };
    const source = `${serverSource.slice(start, end)}\nreturn resolveSafeRemoteImageDownloadTarget;`;
    const resolveSafeRemoteImageDownloadTarget = new Function('net', 'dns', source)(net, fakeDns) as (imageUrl: string) => Promise<unknown>;

    await expect(resolveSafeRemoteImageDownloadTarget('https://example.com/image.png'))
      .rejects.toThrow('远程图片 URL 解析到内网或保留地址');
  });
});

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(
  path.resolve(testDir, '../../../../backend/server.js'),
  'utf8',
);

describe('backend model list proxy', () => {
  it('accepts model check credentials through POST body instead of URL query', () => {
    expect(serverSource).toContain("req.method === 'POST' && apiPathname === '/api/flyreq/proxy/models'");
    expect(serverSource).toContain('const body = await readJsonBody(req, { maxBytes: SMALL_JSON_BODY_BYTES })');
    expect(serverSource).toContain("const apiKey = String(body?.apiKey || '')");
    expect(serverSource).not.toContain("parsed.searchParams.get('apiKey')");
  });

  it('rejects invalid proxy protocols before forwarding upstream requests', () => {
    expect(serverSource).toContain('function validateProxyProtocol');
    expect(serverSource).toContain('const protocol = validateProxyProtocol(body?.protocol)');
    expect(serverSource).toContain("sendJson(res, 400, { error: '协议类型无效，必须为 google 或 openai' })");
  });

  it('rejects Google model checks without a model id instead of falling back to OpenAI models', () => {
    expect(serverSource).toContain("if (protocol === 'google' && !modelId)");
    expect(serverSource).toContain("sendJson(res, 400, { error: '模型名称不能为空' })");
  });

  it('propagates client disconnects to text proxy upstream requests', () => {
    expect(serverSource).toContain('function createRequestAbortSignal');
    expect(serverSource).toMatch(/proxyAbort\s*=\s*createRequestAbortSignal\(req, res\)/);
    expect(serverSource).toContain('signal: proxyAbort.signal');
    expect(serverSource).toContain('await reader.cancel()');
    expect(serverSource).toContain('proxyAbort.cleanup()');
  });
});

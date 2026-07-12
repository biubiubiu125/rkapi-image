import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(
  path.resolve(testDir, '../../../../backend/server.js'),
  'utf8',
);

describe('backend xAI Imagine rate limiting', () => {
  it('paces requests per API key and retries a rate-limited response once', () => {
    expect(serverSource).toContain('const XAI_IMAGINE_MAX_REQUESTS_PER_SECOND = 5');
    expect(serverSource).toContain('async function waitForXaiImagineRequestSlot(apiKey)');
    expect(serverSource).toContain('xaiImagineNextRequestAtByApiKeyHash');
    expect(serverSource).toContain('await waitForXaiImagineRequestSlot(apiKey)');
    expect(serverSource).toContain('response.status !== 429 || attempt === XAI_IMAGINE_MAX_RETRIES');
  });
});

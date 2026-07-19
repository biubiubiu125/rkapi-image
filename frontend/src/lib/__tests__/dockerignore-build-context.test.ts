import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '../../../..');

describe('docker build context', () => {
  it('excludes local frontend build artifacts that Dockerfile rebuilds', () => {
    const patterns = fs.readFileSync(path.join(repositoryRoot, '.dockerignore'), 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    expect(patterns).toContain('frontend/.next/');
    expect(patterns).toContain('frontend/public/sw.js');
    expect(patterns).toContain('frontend/public/workbox-*.js');
  });
});

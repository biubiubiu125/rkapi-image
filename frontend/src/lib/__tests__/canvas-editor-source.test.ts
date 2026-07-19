import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '../../../..');
const canvasEditorSource = fs.readFileSync(
  path.join(repositoryRoot, 'frontend', 'src', 'components', 'canvas', 'CanvasEditor.tsx'),
  'utf8',
);

function getCallbackSource(name: string): string {
  const start = canvasEditorSource.indexOf(`const ${name} = useCallback`);
  const nextCallback = canvasEditorSource.indexOf('\n  const ', start + 1);
  const end = nextCallback > start ? nextCallback : canvasEditorSource.length;
  if (start < 0 || end <= start) throw new Error(`Unable to locate ${name}`);
  return canvasEditorSource.slice(start, end);
}

describe('CanvasEditor server task cleanup closure', () => {
  it('cancels active generation tasks before deleting result nodes', () => {
    const source = getCallbackSource('deleteNodes');
    const cancelIndex = source.indexOf('cancelServerTaskWithRetry');
    const commitIndex = source.indexOf('commitCanvasSnapshot');

    expect(source).toContain('activeGenerationsRef.current.get(node.id)?.abort()');
    expect(source).toContain('node.metadata?.generationTaskId');
    expect(source).toContain('cancelServerTaskWithRetry');
    expect(cancelIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(-1);
    expect(cancelIndex).toBeLessThan(commitIndex);
  });
});

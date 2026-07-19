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

  it('clears config-node busy state only after that config node has no active children', () => {
    const source = getCallbackSource('startNodeGeneration');

    expect(canvasEditorSource).toContain('activeGenerationSourcesRef');
    expect(source).toContain('activeGenerationSourcesRef.current.set(nodeId, sourceNodeId)');
    expect(source).toContain('activeGenerationSourcesRef.current.delete(nodeId)');
    expect(source).toContain('activeGenerationSourcesRef.current.values()');
    expect(source).toContain('activeSourceNodeId === sourceNodeId');
    expect(source).not.toContain('activeGenerationsRef.current.keys()');
  });

  it('queues removed canvas image blobs for targeted cleanup without ignoring undo history', () => {
    const deleteSource = getCallbackSource('deleteNodes');
    const clearSource = getCallbackSource('clearNodeImage');

    expect(canvasEditorSource).toContain('pendingImageCleanupKeysRef');
    expect(canvasEditorSource).toContain('imageCleanupRevision');
    expect(canvasEditorSource).toContain('collectImageStorageKeys');
    expect(canvasEditorSource).toContain('deleteStoredImages(unusedKeys)');
    expect(canvasEditorSource).toContain('undoStack');
    expect(canvasEditorSource).toContain('redoStack');
    expect(canvasEditorSource).not.toContain('queueMicrotask(() =>');
    expect(deleteSource).toContain('queueImageCleanup');
    expect(clearSource).toContain('queueImageCleanup');
  });
});

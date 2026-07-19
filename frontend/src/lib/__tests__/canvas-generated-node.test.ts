import { describe, expect, it } from 'vitest';
import { applyGeneratedImageToCanvasNodes } from '@/components/canvas/utils/canvas-generated-node';
import { CanvasNodeType, type CanvasNodeData } from '@/components/canvas/types';

function makeImageNode(id: string): CanvasNodeData {
  return {
    id,
    type: CanvasNodeType.Image,
    title: id,
    position: { x: 0, y: 0 },
    width: 100,
    height: 100,
    metadata: { status: 'queued', generationTaskId: 'task-1', generationStartedAt: 1 },
  };
}

describe('applyGeneratedImageToCanvasNodes', () => {
  it('updates the target image node without dropping concurrently added nodes', () => {
    const nodes = [makeImageNode('target'), makeImageNode('concurrent')];

    const result = applyGeneratedImageToCanvasNodes(nodes, 'target', {
      storageKey: 'image:stored',
      url: 'blob:stored',
      width: 1024,
      height: 768,
      mimeType: 'image/png',
      bytes: 24,
    }, { prompt: '城市' });

    expect(result.updated).toBe(true);
    expect(result.nodes.map(node => node.id)).toEqual(['target', 'concurrent']);
    expect(result.nodes[0].metadata).toMatchObject({
      status: 'success',
      content: 'blob:stored',
      storageKey: 'image:stored',
      prompt: '城市',
      generationTaskId: 'task-1',
      generationStartedAt: 1,
    });
  });

  it('reports when the target node is missing so callers can avoid acking the server task', () => {
    const nodes = [makeImageNode('other')];

    const result = applyGeneratedImageToCanvasNodes(nodes, 'missing', {
      storageKey: 'image:stored',
      url: 'blob:stored',
      width: 1024,
      height: 768,
      mimeType: 'image/png',
      bytes: 24,
    });

    expect(result.updated).toBe(false);
    expect(result.nodes).toBe(nodes);
  });
});

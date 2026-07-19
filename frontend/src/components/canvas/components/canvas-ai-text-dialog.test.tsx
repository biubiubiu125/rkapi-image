import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AiTextGenerateDialog } from './canvas-ai-text-dialog';
import { CanvasNode } from './canvas-node';
import { CanvasNodeType } from '../types';

describe('AiTextGenerateDialog', () => {
  it('keeps cancel available while text generation is loading', () => {
    const onCancel = vi.fn();
    render(
      <AiTextGenerateDialog
        open
        onOpenChange={vi.fn()}
        originalContent=""
        generatedContent=""
        loading
        error={null}
        onPromptSubmit={vi.fn()}
        onAccept={vi.fn()}
        onCancel={onCancel}
      />,
    );

    const cancelButton = screen.getByRole('button', { name: /取消|鍙栨秷/ });
    expect(cancelButton).not.toBeDisabled();
    fireEvent.click(cancelButton);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('CanvasNode generation recovery', () => {
  it('shows a progress recovery button for recoverable errored image tasks', async () => {
    const onRefreshProgress = vi.fn();

    render(
      <CanvasNode
        data={{
          id: 'node-1',
          type: CanvasNodeType.Image,
          title: '生成结果',
          position: { x: 0, y: 0 },
          width: 320,
          height: 240,
          metadata: {
            status: 'error',
            errorDetails: '生成结果保存失败',
            generationTaskId: 'task-1',
            recoverableGenerationTask: true,
          },
        }}
        isSelected={false}
        isRelated={false}
        isConnectionTarget={false}
        zIndex={1}
        showImageInfo={false}
        onPointerDownNode={vi.fn()}
        onSelectNode={vi.fn()}
        onContextMenu={vi.fn()}
        onConnectStart={vi.fn()}
        onResizeStart={vi.fn()}
        onContentChange={vi.fn()}
        onRetry={vi.fn()}
        onRefreshProgress={onRefreshProgress}
      />,
    );

    const button = screen.getByRole('button', { name: /获取当前进度/ });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(onRefreshProgress).toHaveBeenCalledTimes(1);
  });
});

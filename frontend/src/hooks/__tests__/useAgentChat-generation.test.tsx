import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentChat } from '@/hooks/useAgentChat';
import { ackFlyreqTask, createFlyreqTask, getFlyreqTask, resolveImageTaskProvider } from '@/lib/flyreq-task-client';
import { describeImage, streamAgentChat } from '@/lib/agent-chat-client';
import {
  clearPendingGeneration,
  loadAgentSession,
  putImageRecord,
  putMessage,
  savePendingGeneration,
  storeAgentImageBytes,
} from '@/lib/agent-context-store';
import type { AgentProposal } from '@/lib/agent-chat-config';
import type { AgentResolvedLayout } from '@/lib/model-capabilities';

vi.mock('@/components/LanguageProvider', () => ({
  useI18n: () => ({
    locale: 'zh',
    t: (key: string, params?: Record<string, string>) => {
      if (key === 'agentGeneration.analysis') return '分析';
      if (key === 'agentGeneration.optimizedPrompt') return '优化提示词';
      if (key === 'agentGeneration.result') return '结果';
      if (key === 'agentGeneration.completedAnalysis') return '已完成分析';
      if (key === 'agentGeneration.completedResult') return `已生成 ${params?.images || ''}`;
      if (key === 'agentGeneration.partialFailure') return `部分失败 ${params?.errors || ''}`;
      return key;
    },
  }),
}));

vi.mock('@/hooks/useModelRegistryRefresh', () => ({
  useModelRegistryRefresh: vi.fn(),
}));

vi.mock('@/lib/settings-storage', () => ({
  hasConfiguredTextModel: vi.fn(() => true),
}));

vi.mock('@/lib/flyreq-models', () => ({
  getCompleteImageModels: vi.fn(() => []),
  loadRegistry: vi.fn(() => ({ imageModels: [], textModels: [], defaults: {} })),
}));

vi.mock('@/lib/model-endpoints', () => ({
  getDefaultConfiguredTextModel: vi.fn(() => ({
    apiKey: 'text-key',
    baseUrl: 'https://text.example.com',
    protocol: 'openai',
    modelId: 'gpt-test',
  })),
}));

vi.mock('@/lib/agent-chat-client', () => ({
  describeImage: vi.fn(),
  streamAgentChat: vi.fn(),
}));

vi.mock('@/lib/flyreq-task-client', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/flyreq-task-client')>();
  return {
    ...actual,
    ackFlyreqTask: vi.fn(),
    createFlyreqTask: vi.fn(),
    getFlyreqTask: vi.fn(),
    resolveImageTaskProvider: vi.fn(),
  };
});

vi.mock('@/lib/agent-context-store', () => ({
  clearAgentSession: vi.fn(),
  clearPendingGeneration: vi.fn(),
  clearPendingProposal: vi.fn(),
  deleteAgentImageBytes: vi.fn(),
  deleteImageRecords: vi.fn(),
  deleteMessages: vi.fn(),
  getAgentImageBase64: vi.fn(),
  loadAgentSession: vi.fn(),
  loadPendingGeneration: vi.fn(),
  loadPendingProposal: vi.fn(),
  putImageRecord: vi.fn(),
  putMessage: vi.fn(),
  saveImageModel: vi.fn(),
  savePendingGeneration: vi.fn(),
  savePendingProposal: vi.fn(),
  storeAgentImageBytes: vi.fn(),
}));

const mockedAckFlyreqTask = vi.mocked(ackFlyreqTask);
const mockedCreateFlyreqTask = vi.mocked(createFlyreqTask);
const mockedGetFlyreqTask = vi.mocked(getFlyreqTask);
const mockedResolveImageTaskProvider = vi.mocked(resolveImageTaskProvider);
const mockedStreamAgentChat = vi.mocked(streamAgentChat);
const mockedDescribeImage = vi.mocked(describeImage);
const mockedLoadAgentSession = vi.mocked(loadAgentSession);
const mockedPutMessage = vi.mocked(putMessage);
const mockedPutImageRecord = vi.mocked(putImageRecord);
const mockedSavePendingGeneration = vi.mocked(savePendingGeneration);
const mockedStoreAgentImageBytes = vi.mocked(storeAgentImageBytes);
const mockedClearPendingGeneration = vi.mocked(clearPendingGeneration);

const proposal: AgentProposal = {
  action: 'generate',
  prompt: '画一座城市',
  referencedImageIds: [],
  reason: '用户要求生图',
  suggestedAspectRatio: '1:1',
  temperature: 1,
  gptImageQuality: 'auto',
  gptImageBackground: 'auto',
  parallelCount: 1,
};

const params: AgentResolvedLayout = {
  outputSize: '1K',
  aspectRatio: '1:1',
  temperature: 1,
  gptImageQuality: 'auto',
  gptImageStyle: 'auto',
  gptImageBackground: 'auto',
  gptImageOutputFormat: 'png',
  parallelCount: 1,
};

async function enterProposal(result: { current: ReturnType<typeof useAgentChat> }) {
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => {
    result.current.sendMessage('帮我生成图片', [], []);
  });
  await waitFor(() => expect(result.current.phase).toBe('proposal'));
}

describe('useAgentChat generated task persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadAgentSession.mockResolvedValue({ messages: [], images: [], imageModel: null });
    mockedPutMessage.mockResolvedValue(undefined);
    mockedPutImageRecord.mockResolvedValue(undefined);
    mockedSavePendingGeneration.mockResolvedValue(undefined);
    mockedStoreAgentImageBytes.mockResolvedValue(undefined);
    mockedClearPendingGeneration.mockResolvedValue(undefined);
    mockedAckFlyreqTask.mockResolvedValue(undefined);
    mockedCreateFlyreqTask.mockResolvedValue('task-1');
    mockedGetFlyreqTask.mockResolvedValue({
      id: 'task-1',
      status: 'completed',
      result: { images: ['data:image/png;base64,aW1hZ2U='] },
    });
    mockedResolveImageTaskProvider.mockReturnValue({
      apiKey: 'image-key',
      baseUrl: 'https://image.example.com',
      protocol: 'openai',
      modelId: 'gpt-image-2',
    });
    mockedDescribeImage.mockResolvedValue('');
    mockedStreamAgentChat.mockImplementation((_input, callbacks) => {
      queueMicrotask(() => callbacks.onDone('分析文本', proposal));
      return { promise: Promise.resolve(), abort: vi.fn() };
    });
  });

  it('waits for the generated assistant message to persist before clearing pending state and acking', async () => {
    let resolveAssistantMessage!: () => void;
    mockedPutMessage.mockImplementation(async message => {
      if (message.role === 'assistant' && message.taskId === 'task-1') {
        await new Promise<void>(resolve => { resolveAssistantMessage = resolve; });
      }
    });
    const { result } = renderHook(() => useAgentChat());
    await enterProposal(result);

    let approval: Promise<void> | undefined;
    await act(async () => {
      approval = result.current.approveProposal('画一座城市', [], 'rkapi-4k-image', params);
    });
    await waitFor(() => expect(mockedPutMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: 'assistant',
      taskId: 'task-1',
    })));

    expect(mockedClearPendingGeneration).not.toHaveBeenCalled();
    expect(mockedAckFlyreqTask).not.toHaveBeenCalled();

    await act(async () => {
      resolveAssistantMessage();
      await approval;
    });

    expect(mockedAckFlyreqTask).toHaveBeenCalledWith('task-1', undefined);
    expect(mockedClearPendingGeneration).toHaveBeenCalled();
  });

  it('keeps pending generation and does not ack when generated image records cannot persist', async () => {
    mockedPutImageRecord.mockRejectedValue(new Error('浏览器本地持久存储不可用'));
    const { result } = renderHook(() => useAgentChat());
    await enterProposal(result);

    await act(async () => {
      await result.current.approveProposal('画一座城市', [], 'rkapi-4k-image', params);
    });

    expect(mockedClearPendingGeneration).not.toHaveBeenCalled();
    expect(mockedAckFlyreqTask).not.toHaveBeenCalled();
    expect(result.current.error).toContain('浏览器本地持久存储不可用');
    expect(result.current.phase).toBe('generating');
    expect(result.current.generatingTaskId).toBe('task-1');
    expect(result.current.generationDraft?.taskId).toBe('task-1');
  });

  it('can recover the same completed task from check-now after a local persistence failure', async () => {
    mockedPutImageRecord
      .mockRejectedValueOnce(new Error('浏览器本地持久存储不可用'))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useAgentChat());
    await enterProposal(result);

    await act(async () => {
      await result.current.approveProposal('画一座城市', [], 'rkapi-4k-image', params);
    });

    expect(result.current.phase).toBe('generating');
    expect(mockedAckFlyreqTask).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.checkNow();
    });

    await waitFor(() => expect(mockedAckFlyreqTask).toHaveBeenCalledWith('task-1', undefined));
    expect(mockedClearPendingGeneration).toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
    expect(result.current.generatingTaskId).toBeNull();
    expect(result.current.generationDraft).toBeNull();
  });

  it('deduplicates generated task finalization when check-now races with polling completion', async () => {
    mockedGetFlyreqTask
      .mockResolvedValueOnce({
        id: 'task-1',
        status: 'processing',
      })
      .mockResolvedValue({
        id: 'task-1',
        status: 'completed',
        result: { images: ['data:image/png;base64,aW1hZ2U='] },
      });
    const assistantMessageResolvers: Array<() => void> = [];
    mockedPutMessage.mockImplementation(async message => {
      if (message.role === 'assistant' && message.taskId === 'task-1') {
        await new Promise<void>(resolve => { assistantMessageResolvers.push(resolve); });
      }
    });
    const { result } = renderHook(() => useAgentChat());
    await enterProposal(result);

    let approval: Promise<void> | undefined;
    await act(async () => {
      approval = result.current.approveProposal('draw a city', [], 'rkapi-4k-image', params);
      await Promise.resolve();
    });
    await waitFor(() => expect(mockedGetFlyreqTask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.phase).toBe('generating'));

    let checkNow: Promise<unknown> | undefined;
    await act(async () => {
      checkNow = result.current.checkNow();
      await Promise.resolve();
    });

    await waitFor(() => expect(assistantMessageResolvers).toHaveLength(1));
    await Promise.resolve();
    expect(mockedStoreAgentImageBytes).toHaveBeenCalledTimes(1);
    expect(mockedPutImageRecord).toHaveBeenCalledTimes(1);

    await act(async () => {
      assistantMessageResolvers.forEach(resolve => resolve());
      await Promise.all([approval, checkNow]);
    });

    expect(mockedAckFlyreqTask).toHaveBeenCalledTimes(1);
    expect(mockedClearPendingGeneration).toHaveBeenCalledTimes(1);
  });

  it('keeps the same task recoverable when check-now still cannot persist the completed result', async () => {
    mockedPutImageRecord.mockRejectedValue(new Error('浏览器本地持久存储不可用'));
    const { result } = renderHook(() => useAgentChat());
    await enterProposal(result);

    await act(async () => {
      await result.current.approveProposal('画一座城市', [], 'rkapi-4k-image', params);
    });

    expect(result.current.phase).toBe('generating');

    await act(async () => {
      await result.current.checkNow();
    });

    expect(mockedAckFlyreqTask).not.toHaveBeenCalled();
    expect(mockedClearPendingGeneration).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('generating');
    expect(result.current.generatingTaskId).toBe('task-1');
    expect(result.current.generationDraft?.taskId).toBe('task-1');
  });

  it('keeps pending generation recoverable when polling fails after the task id is persisted', async () => {
    mockedGetFlyreqTask.mockRejectedValueOnce(new Error('temporary network'));
    const { result } = renderHook(() => useAgentChat());
    await enterProposal(result);

    await act(async () => {
      await result.current.approveProposal('画一座城市', [], 'rkapi-4k-image', params);
    });

    expect(mockedClearPendingGeneration).not.toHaveBeenCalled();
    expect(mockedAckFlyreqTask).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('generating');
    expect(result.current.generatingTaskId).toBe('task-1');
    expect(result.current.generationDraft?.taskId).toBe('task-1');
    expect(result.current.error).toContain('temporary network');
    expect(result.current.error).toContain('task-1');
  });

  it('does not poll or ack when pending generation cannot be persisted after task creation', async () => {
    mockedSavePendingGeneration.mockRejectedValue(new Error('浏览器本地持久存储不可用'));
    const { result } = renderHook(() => useAgentChat());
    await enterProposal(result);

    await act(async () => {
      await result.current.approveProposal('画一座城市', [], 'rkapi-4k-image', params);
    });

    expect(mockedCreateFlyreqTask).toHaveBeenCalled();
    expect(mockedGetFlyreqTask).not.toHaveBeenCalled();
    expect(mockedAckFlyreqTask).not.toHaveBeenCalled();
    expect(mockedClearPendingGeneration).not.toHaveBeenCalled();
    expect(result.current.error).toContain('task-1');
    expect(result.current.phase).toBe('proposal');
  });

  it('keeps pending generation and does not ack when any image in a multi-image result cannot persist', async () => {
    mockedGetFlyreqTask.mockResolvedValue({
      id: 'task-1',
      status: 'completed',
      result: {
        images: [
          'data:image/png;base64,aW1hZ2Ux',
          'data:image/png;base64,aW1hZ2Uy',
        ],
      },
    });
    mockedPutImageRecord
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('第二张图片保存失败'));
    const { result } = renderHook(() => useAgentChat());
    await enterProposal(result);

    await act(async () => {
      await result.current.approveProposal('画两张城市图', [], 'rkapi-4k-image', {
        ...params,
        parallelCount: 2,
      });
    });

    expect(mockedPutImageRecord).toHaveBeenCalledTimes(2);
    expect(mockedAckFlyreqTask).not.toHaveBeenCalled();
    expect(mockedClearPendingGeneration).not.toHaveBeenCalled();
    expect(result.current.error).toContain('第二张图片保存失败');
  });

  it('surfaces backend partial-success warnings when fewer images return than requested', async () => {
    mockedGetFlyreqTask.mockResolvedValue({
      id: 'task-1',
      status: 'completed',
      result: { images: ['data:image/png;base64,aW1hZ2U='] },
      warning: '1 张图片生成失败: upstream quota',
    });
    const { result } = renderHook(() => useAgentChat());
    await enterProposal(result);

    await act(async () => {
      await result.current.approveProposal('画两张城市图', [], 'rkapi-4k-image', {
        ...params,
        parallelCount: 2,
      });
    });

    await waitFor(() => expect(mockedAckFlyreqTask).toHaveBeenCalledWith('task-1', undefined));
    expect(mockedPutMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: 'assistant',
      taskId: 'task-1',
      text: expect.stringContaining('部分失败'),
    }));
    expect(mockedPutMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: 'assistant',
      taskId: 'task-1',
      text: expect.stringContaining('仅返回 1/2 张图片'),
    }));
    expect(mockedPutMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: 'assistant',
      taskId: 'task-1',
      text: expect.stringContaining('upstream quota'),
    }));
  });

  it('does not start a text chat when the user message cannot persist', async () => {
    mockedPutMessage.mockRejectedValue(new Error('浏览器本地持久存储不可用'));
    const { result } = renderHook(() => useAgentChat());
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.sendMessage('这条消息必须先落盘', [], []);
    });

    expect(mockedStreamAgentChat).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
    expect(result.current.error).toContain('浏览器本地持久存储不可用');
    expect(result.current.phase).toBe('idle');
  });

  it('does not append a pure assistant reply when the reply cannot persist', async () => {
    mockedStreamAgentChat.mockImplementation((_input, callbacks) => {
      queueMicrotask(() => callbacks.onDone('纯文本回复', null));
      return { promise: Promise.resolve(), abort: vi.fn() };
    });
    mockedPutMessage.mockImplementation(async message => {
      if (message.role === 'assistant') throw new Error('Agent 消息持久化失败');
    });
    const { result } = renderHook(() => useAgentChat());
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.sendMessage('只聊天不生图', [], []);
    });

    await waitFor(() => expect(result.current.phase).toBe('idle'));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].role).toBe('user');
    expect(result.current.error).toContain('Agent 消息持久化失败');
  });
});

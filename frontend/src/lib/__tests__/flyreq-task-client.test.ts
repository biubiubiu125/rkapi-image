import { afterEach, describe, expect, it, vi } from 'vitest';
import { ackFlyreqTask, cancelFlyreqTask, createFlyreqTask, createFlyreqTasks, getFlyreqTask, type CreateFlyreqTaskInput } from '@/lib/flyreq-task-client';

function makeCreateTaskInput(overrides: Partial<CreateFlyreqTaskInput> = {}): CreateFlyreqTaskInput {
  return {
    apiKey: 'test-api-key',
    baseUrl: 'https://api.example.com',
    protocol: 'openai',
    mode: 'image-to-image',
    prompt: 'prompt',
    outputSize: '1K',
    aspectRatio: '1:1',
    model: 'gpt-image-2',
    parallelCount: 1,
    images: [],
    ...overrides,
  };
}

function makeReferenceData(megabytes: number): string {
  return 'a'.repeat(megabytes * 1024 * 1024);
}

describe('flyreq task client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an expired task body from the 404 fallback response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'task-expired',
      status: 'expired',
      error: '该任务已超出取回时间',
    }), { status: 404 })));

    await expect(getFlyreqTask('task-expired')).resolves.toEqual({
      id: 'task-expired',
      status: 'expired',
      error: '该任务已超出取回时间',
    });
  });

  it('returns task id with read token for single task creation and uses token header on follow-up requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        taskId: 'task-1',
        readToken: 'token-1',
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'task-1',
        status: 'processing',
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        acknowledged: true,
      })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createFlyreqTask(makeCreateTaskInput())).resolves.toEqual({
      taskId: 'task-1',
      readToken: 'token-1',
    });
    await getFlyreqTask('task-1', 'token-1');
    await ackFlyreqTask('task-1', 'token-1');

    expect(fetchMock.mock.calls[1][0]).toBe('/api/flyreq/tasks/task-1');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      headers: { 'X-Flyreq-Task-Token': 'token-1' },
    });
    expect(fetchMock.mock.calls[2][0]).toBe('/api/flyreq/tasks/task-1/ack');
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      headers: { 'X-Flyreq-Task-Token': 'token-1' },
    });
  });

  it('returns task ids with read tokens for batch creation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      tasks: [
        { taskId: 'task-1', readToken: 'token-1' },
        { taskId: 'task-2', readToken: 'token-2' },
      ],
    }))));

    await expect(createFlyreqTasks(makeCreateTaskInput({ parallelCount: 2 }))).resolves.toEqual([
      { taskId: 'task-1', readToken: 'token-1' },
      { taskId: 'task-2', readToken: 'token-2' },
    ]);
  });

  it('throws when server task acknowledgement is rejected by the backend', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'ack failed',
    }), { status: 500 })));

    await expect(ackFlyreqTask('task-1')).rejects.toMatchObject({
      statusCode: 500,
      message: 'ack failed',
    });
  });

  it('throws when the backend says the task was not acknowledged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      acknowledged: false,
    }))));

    await expect(ackFlyreqTask('task-1')).rejects.toThrow('服务端未确认任务 ack');
  });
  it('uses the read token when cancelling a server task', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      cancelled: true,
    })));
    vi.stubGlobal('fetch', fetchMock);

    await cancelFlyreqTask('task-1', 'token-1');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/flyreq/tasks/task-1/cancel');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { 'X-Flyreq-Task-Token': 'token-1' },
    });
  });

  it('rejects an oversized single task body before calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(createFlyreqTask(makeCreateTaskInput({
      images: [{ data: makeReferenceData(50), mimeType: 'image/png' }],
    }))).rejects.toThrow('请求体过大');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized batch task body before calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(createFlyreqTasks(makeCreateTaskInput({
      parallelCount: 2,
      images: [{ data: makeReferenceData(50), mimeType: 'image/png' }],
    }))).rejects.toThrow('请求体过大');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

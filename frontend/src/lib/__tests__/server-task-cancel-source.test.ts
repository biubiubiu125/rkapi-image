import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '../../../..');
const serverSource = fs.readFileSync(path.join(repositoryRoot, 'backend', 'server.js'), 'utf8');
const workspaceJobsSource = fs.readFileSync(path.resolve(testDir, '../../hooks/useWorkspaceJobs.ts'), 'utf8');

describe('server task cancellation closure', () => {
  it('exposes token-protected cancel route for server tasks', () => {
    expect(serverSource).toContain('(?:\\/(ack|cancel))');
    expect(serverSource).toContain("req.method === 'POST' && action === 'cancel'");
    expect(serverSource).toContain("verifyTaskReadToken(taskId, getRequestReadToken(req) || parsedUrl.searchParams.get('token'))");
  });

  it('cancels queued and processing work through runtime state', () => {
    expect(serverSource).toContain('const taskAbortControllers = new Map();');
    expect(serverSource).toContain('const cancelledTaskIds = new Set();');
    expect(serverSource).toContain('function cancelTask(taskId)');
    expect(serverSource).toContain('removeQueuedTask(taskId)');
    expect(serverSource).toContain('taskAbortControllers.get(taskId)');
    expect(serverSource).toContain('abortController.abort(new Error(TASK_CANCELLED_ERROR))');
    expect(serverSource).toContain('cancelledTaskIds.has(taskId)');
    expect(serverSource).toContain('generateSingleImage(apiKey, request, taskId, index, abortController.signal)');
  });

  it('propagates the same cancellation signal through delayed retries and remote image downloads', () => {
    expect(serverSource).toContain('waitForXaiImagineRequestSlot(apiKey, options.signal)');
    expect(serverSource).toContain('delay(retryDelayMs, options.signal)');
    expect(serverSource).toContain('downloadUrlToDisk(taskId, index, subIdx, remoteUrl, { apiKey, request: requestForImage, signal })');
    expect(serverSource).toContain('fetchPinnedRemoteImage(target, getHeaderObject(options.headers, imageUrl), { signal: options.signal })');
    expect(serverSource).toContain('readResponseBufferWithLimit(response, MAX_REMOTE_IMAGE_BYTES, options.signal)');
  });

  it('keeps task cancellation and request timeout active while reading upstream image response bodies', () => {
    const parseSource = serverSource.slice(
      serverSource.indexOf('async function parseGptImageResponse'),
      serverSource.indexOf('\nasync function requestGptImage'),
    );
    const gptSource = serverSource.slice(
      serverSource.indexOf('async function requestGptImage'),
      serverSource.indexOf('\nasync function requestXaiImagineImage'),
    );
    const xaiSource = serverSource.slice(
      serverSource.indexOf('async function requestXaiImagineImage'),
      serverSource.indexOf('\n// ===== 加强网络连接'),
    );
    const geminiSource = serverSource.slice(
      serverSource.indexOf('async function generateFlyreqGeminiImage'),
      serverSource.indexOf('\nfunction drainQueue'),
    );

    expect(serverSource).toContain('async function readResponseTextWithAbort(response, signal)');
    expect(parseSource).toContain('parseGptImageResponse(response, signal)');
    expect(parseSource).toContain('readResponseTextWithAbort(response, signal)');
    expect(parseSource).not.toContain('await response.text()');
    expect(gptSource).toContain('parseGptImageResponse(response, signal)');
    expect(xaiSource).toContain('parseGptImageResponse(response, signal)');
    expect(xaiSource).toContain('readResponseTextWithAbort(response, signal)');
    expect(geminiSource).toContain('readResponseTextWithAbort(response, signal)');
    expect(geminiSource).not.toContain('await response.text()');
  });

  it('notifies the server when removing a locally stored generation job', () => {
    expect(workspaceJobsSource).toContain('cancelServerTaskWithRetry');
    expect(workspaceJobsSource).toContain('cancelRemovedServerTask(removedJob)');
    expect(workspaceJobsSource).toContain('cancelRemovedServerTask(job)');
  });
});

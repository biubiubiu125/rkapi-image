import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDir, '../../../..');
const serverSource = fs.readFileSync(path.join(repositoryRoot, 'backend', 'server.js'), 'utf8');
const releaseWorkflow = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8');

function getFunctionSource(name: string): string {
  const start = serverSource.indexOf(`function ${name}`);
  const nextFunction = serverSource.indexOf(`\nfunction `, start + 1);
  const end = nextFunction > start ? nextFunction : serverSource.length;
  if (start < 0 || end <= start) throw new Error(`Unable to locate ${name}`);
  return serverSource.slice(start, end);
}

describe('backend runtime closure safeguards', () => {
  it('uses the shared RKAPI/FLYREQ env resolver for persisted task database and image directory', () => {
    expect(serverSource).toContain("getRuntimeEnvValue(getRuntimeEnv(), 'TASK_DB')");
    expect(serverSource).toContain("getRuntimeEnvValue(getRuntimeEnv(), 'IMAGE_DIR')");
  });

  it('keeps process environment ahead of startup .env values while allowing runtime-only file refreshes', () => {
    const source = getFunctionSource('getRuntimeEnv');

    expect(source).toContain('const fileEnv = parseEnvFiles()');
    expect(source).toContain('values: { ...fileEnv, ...process.env, ...getRuntimeOnlyEnv(fileEnv) }');
    expect(source).not.toContain('values: { ...process.env, ...fileEnv }');
  });

  it('keeps runtime-refreshable .env keys out of startup process.env hydration', () => {
    const loadSource = getFunctionSource('loadEnvFile');
    const runtimeKeySource = getFunctionSource('isRuntimeEnvFileKey');

    expect(loadSource).toContain('if (isRuntimeEnvFileKey(key)) continue');
    expect(runtimeKeySource).toContain('RUNTIME_DIRECT_ENV_KEYS.has(key)');
    expect(runtimeKeySource).toContain("key.startsWith(currentPrefix)");
    expect(runtimeKeySource).toContain("key.startsWith(legacyPrefix)");
  });

  it('refreshes runtime-only .env values from the Docker data volume after startup', () => {
    const envPathSource = serverSource.slice(
      serverSource.indexOf('const ENV_FILE_PATHS'),
      serverSource.indexOf('const TASK_STATUS'),
    );
    const runtimeSource = getFunctionSource('getRuntimeEnv');
    const runtimeOnlySource = getFunctionSource('getRuntimeOnlyEnv');

    expect(envPathSource).toContain("path.join(__dirname, 'data', '.env')");
    expect(envPathSource).toContain('RUNTIME_ENV_VALUE_KEYS');
    expect(envPathSource).toContain('RUNTIME_DIRECT_ENV_KEYS');
    expect(runtimeOnlySource).toContain('getRuntimeEnvValue(');
    expect(runtimeSource).toContain('values: { ...fileEnv, ...process.env, ...getRuntimeOnlyEnv(fileEnv) }');
  });

  it('wraps task execution in an outer failure finalizer', () => {
    const source = serverSource.slice(
      serverSource.indexOf('async function runTask'),
      serverSource.indexOf('\nfunction serializeTask'),
    );

    expect(source).toContain('try {');
    expect(source).toContain('catch (error)');
    expect(source).toContain('UPDATE tasks');
    expect(source).toContain("status = 'failed'");
    expect(source).toContain('finally');
    expect(source).toContain('cleanupTaskRuntimeState(taskId)');
    expect(source).toContain('broadcastQueueStatus()');
  });

  it('creates and verifies read tokens for task status, images, ack, and websocket subscriptions', () => {
    expect(serverSource).toContain('read_token_hash TEXT');
    expect(serverSource).toContain('generateTaskReadToken');
    expect(serverSource).toContain('hashTaskReadToken');
    expect(serverSource).toContain('verifyTaskReadToken');
    expect(serverSource).toContain('readToken');
    expect(serverSource).toContain('verifyTaskReadToken(taskId, parsedUrl.searchParams.get');
    expect(serverSource).toContain('verifyTaskReadToken(taskId, getRequestReadToken(req)');
    expect(serverSource).toContain('handleSubscribeTasks(ws, msg.tasks)');
  });

  it('exposes a health endpoint that checks sqlite and image storage', () => {
    expect(serverSource).toContain("apiPathname === '/api/flyreq/health'");
    expect(serverSource).toContain('checkHealth()');
    expect(serverSource).toContain("db.prepare('SELECT 1 AS ok')");
    expect(serverSource).toContain('fs.accessSync(IMAGE_DIR');
  });

  it('reads preset model ids and maintenance switches through prefixed runtime aliases', () => {
    expect(serverSource).toContain("getRuntimeEnvValue(env, 'IMAGE_PRESET_MODEL_IDS')");
    expect(serverSource).toContain("getRuntimeEnvValue(env, 'REJECT_NEW_TASKS')");
    expect(serverSource).toContain("getRuntimeEnvValue(env, 'ACCEPT_NEW_TASKS')");
  });

  it('only acknowledges terminal tasks and keeps active work out of cleanup grace', () => {
    expect(serverSource).toContain("SELECT id, status, expires_at FROM tasks WHERE id = ?");
    expect(serverSource).toContain("!['completed', 'failed'].includes(taskForAck.status)");
    expect(serverSource).toContain('TASK_NOT_FOUND');
    expect(serverSource).toContain('TASK_EXPIRED');
    expect(serverSource).toContain('TASK_NOT_TERMINAL');
    expect(serverSource).toContain('acknowledged: true');
    expect(serverSource).not.toContain('acknowledged: Boolean(terminal)');
  });

  it('allows batch tasks to use complete per-image effective prompts when the main prompt is empty', () => {
    expect(serverSource).toContain('hasCompleteEffectivePrompts');
    expect(serverSource).toContain('提示词不能为空');
  });

  it('keeps effective prompts in persisted single-task requests', () => {
    const snapshotSource = getFunctionSource('buildTaskRequestForDb');
    const generateSource = getFunctionSource('generateSingleImage');

    expect(snapshotSource).toContain('effectivePrompts');
    expect(generateSource).toContain('request.effectivePrompts');
  });

  it('requires reference images for image-to-image tasks at the backend boundary', () => {
    const source = getFunctionSource('validateCreatePayload');

    expect(source).toContain("body.mode === 'image-to-image'");
    expect(source).toContain('body.images.length === 0');
  });

  it('pins remote image downloads to checked addresses and limits streamed bytes', () => {
    expect(serverSource).toContain('resolveSafeRemoteImageDownloadTarget');
    expect(serverSource).toContain('createPinnedRemoteImageRequestOptions');
    expect(serverSource).toContain('fetchPinnedRemoteImage');
    expect(serverSource).toContain('MAX_REMOTE_IMAGE_BYTES');
    expect(serverSource).toContain('MAX_REMOTE_IMAGE_REDIRECTS');
    expect(serverSource).toContain('readResponseBufferWithLimit');
  });

  it('checks queue capacity before consuming rate limit quota', () => {
    for (const functionName of ['createTask', 'createTaskBatch']) {
      const source = getFunctionSource(functionName);
      const queueIndex = source.indexOf('enforceQueueCapacity');
      const rateIndex = source.indexOf('enforceRateLimit');

      expect(queueIndex, `${functionName} must check queue capacity`).toBeGreaterThan(-1);
      expect(rateIndex, `${functionName} must enforce rate limit`).toBeGreaterThan(-1);
      expect(queueIndex, `${functionName} should reject full queue before consuming rate quota`).toBeLessThan(rateIndex);
    }
  });

  it('charges batch task rate limits by created task count', () => {
    const rateLimitSource = getFunctionSource('enforceRateLimit');
    const batchSource = getFunctionSource('createTaskBatch');

    expect(rateLimitSource).toContain('requestedTasks = 1');
    expect(rateLimitSource).toContain('checkRateLimit(`ip:${ip}`');
    expect(rateLimitSource).toContain('checkRateLimit(`api:${apiKeyHash}`');
    expect(rateLimitSource).toContain('applyRateLimit(`ip:${ip}`');
    expect(rateLimitSource).toContain('applyRateLimit(`api:${apiKeyHash}`');
    expect(batchSource).toContain('const requestedTasks = body.parallelCount');
    expect(batchSource).toContain('enforceRateLimit(req, body, limitConfig, requestedTasks)');
  });

  it('charges compatible single task rate limits by image slot count', () => {
    const taskSource = getFunctionSource('createTask');

    expect(taskSource).toContain('const requestedTasks = body.parallelCount');
    expect(taskSource).toContain('enforceRateLimit(req, body, limitConfig, requestedTasks)');
    expect(taskSource).toContain('registerTaskRuntimeState(taskId, body.apiKey, body.images, source, requestedTasks)');
  });

  it('loads startup .env before deciding whether Next.js is required', () => {
    const loadIndex = serverSource.indexOf('loadEnvFile();');
    const nextIndex = serverSource.indexOf("process.env.NODE_ENV !== 'production' ? require('next') : null");

    expect(loadIndex).toBeGreaterThan(-1);
    expect(nextIndex).toBeGreaterThan(-1);
    expect(loadIndex).toBeLessThan(nextIndex);
  });

  it('validates task payload fields at the backend boundary', () => {
    const source = getFunctionSource('validateCreatePayload');

    expect(source).toContain('validateImageRequestLayout(body)');
    expect(source).toContain('validateImageReferences(body)');
  });

  it('drains failed remote image response bodies before throwing', () => {
    const source = getFunctionSource('downloadUrlToDisk');
    const failureIndex = source.indexOf('if (!response.ok)');
    const drainIndex = source.indexOf('drainRemoteImageResponseBody(response)', failureIndex);
    const throwIndex = source.indexOf('throw new Error(`远程图片下载失败', failureIndex);

    expect(failureIndex).toBeGreaterThan(-1);
    expect(drainIndex).toBeGreaterThan(failureIndex);
    expect(drainIndex).toBeLessThan(throwIndex);
  });

  it('drains unsupported remote image response bodies before throwing', () => {
    const source = getFunctionSource('downloadUrlToDisk');
    const unsupportedIndex = source.indexOf("if (!/^image\\//i.test(contentType)");
    const drainIndex = source.indexOf('drainRemoteImageResponseBody(response)', unsupportedIndex);
    const throwIndex = source.indexOf('throw new Error(`远程图片类型不支持', unsupportedIndex);

    expect(unsupportedIndex).toBeGreaterThan(-1);
    expect(drainIndex).toBeGreaterThan(unsupportedIndex);
    expect(drainIndex).toBeLessThan(throwIndex);
  });

  it('releases remote image response readers when streamed downloads exceed the byte cap', () => {
    const source = getFunctionSource('readResponseBufferWithLimit');

    expect(source).toContain('reader.releaseLock');
    expect(source).toContain('reader.cancel');
  });

  it('drains advertised oversized remote image response bodies before throwing', () => {
    const source = getFunctionSource('readResponseBufferWithLimit');
    const contentLengthIndex = source.indexOf('contentLength !== undefined && contentLength > maxBytes');
    const drainIndex = source.indexOf('await drainRemoteImageResponseBody(response)', contentLengthIndex);
    const throwIndex = source.indexOf('throw new Error(`远程图片超过大小限制', contentLengthIndex);

    expect(contentLengthIndex).toBeGreaterThan(-1);
    expect(drainIndex).toBeGreaterThan(contentLengthIndex);
    expect(drainIndex).toBeLessThan(throwIndex);
  });

  it('keeps task rows when image file cleanup fails', () => {
    const source = getFunctionSource('deleteTask(taskId)');

    expect(source).toContain('const imageCleanup = deleteTaskImageFiles(taskId)');
    expect(source).toContain('imageCleanup.failed > 0');
    expect(source.indexOf('imageCleanup.failed > 0')).toBeLessThan(source.indexOf("DELETE FROM task_items"));
  });

  it('serves generated image files only while the owning task row is retrievable', () => {
    expect(serverSource).toContain('const taskForImage = db.prepare');
    expect(serverSource).toContain('SELECT id, expires_at FROM tasks WHERE id = ?');
    expect(serverSource).toContain('Date.parse(taskForImage.expires_at) <= Date.now()');
  });

  it('reports queue display counters against configured concurrency', () => {
    const source = getFunctionSource('getQueueStats');

    expect(source).toContain('const configuredConcurrency = getMaxServerConcurrency()');
    expect(source).toContain('concurrencyLimit: GLOBAL_TASK_CONCURRENCY');
    expect(source).toContain('configuredConcurrency,');
    expect(source).toContain('displayConcurrency: Math.min(configuredConcurrency, totalActiveSlots)');
    expect(source).toContain('displayQueued: Math.max(0, totalActiveSlots - configuredConcurrency)');
  });

  it('sanitizes upstream image error payloads before storing task failures', () => {
    expect(serverSource).toContain('function sanitizeUpstreamErrorBody');
    expect(serverSource).toContain('function buildUpstreamHttpErrorMessage');
    expect(serverSource).not.toContain('${getUpstreamHttpErrorPrefix(response.status)}：${responseText}');
    expect(serverSource).not.toContain('`上游服务错误：${responseText}`');
  });

  it('release workflow uploads the generated zip package alongside Docker images', () => {
    expect(releaseWorkflow).toContain('node scripts/pack.js');
    expect(releaseWorkflow).toContain('files: out.zip');
  });
});

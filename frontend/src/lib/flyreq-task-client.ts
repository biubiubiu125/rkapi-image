import type { AspectRatio, OutputSize } from '@/lib/gemini-config';
import type { GptImageBackground, GptImageOutputFormat, GptImageQuality, GptImageStyle } from '@/lib/model-capabilities';
import {
  getCompleteImageModels,
  getCompleteTextModels,
  getImageModelById,
  getResolvedImageModelId,
  getTextModelById,
  loadRegistry,
  getImageApiFlavor,
  type ImageModelConfig,
  type ImageApiFlavor,
  type ProviderProtocol,
  type TextModelConfig,
} from '@/lib/flyreq-models';
import {
  normalizeModelBaseUrl,
} from '@/lib/model-endpoints';

export interface ImageReference {
  data: string;
  mimeType: string;
}

export interface ModelStatus {
  modelId: string;
  available: boolean;
  actualName?: string;
  message?: string;
}

const MODEL_CHECK_TIMEOUT = 30000;
const TASK_REQUEST_TIMEOUT = 30000;
const CREATE_TASK_TIMEOUT = 60000;
const CREATE_TASK_MAX_BODY_BYTES = 10 * 1024 * 1024 - 128 * 1024;

export type FlyreqTaskMode = 'text-to-image' | 'image-to-image';
export type FlyreqTaskStatus = 'queued' | '排队中' | 'processing' | 'completed' | 'failed' | 'expired';

export interface FlyreqTaskSseResult {
  responses: number;
  requests: number;
}

export interface CreateFlyreqTaskInput {
  apiKey: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  imageApiFlavor?: ImageApiFlavor;
  mode: FlyreqTaskMode;
  prompt: string;
  outputSize: OutputSize;
  customSize?: string;
  aspectRatio: AspectRatio;
  temperature?: number;
  model: string;
  gptImageQuality?: GptImageQuality;
  gptImageStyle?: GptImageStyle;
  gptImageBackground?: GptImageBackground;
  gptImageOutputFormat?: GptImageOutputFormat;
  streamImages?: boolean;
  parallelCount: number;
  promptVariants?: string[];
  /** 每张拆分图片实际发送给上游的完整提示词。 */
  effectivePrompts?: string[];
  images: ImageReference[];
}

export interface FlyreqTaskResponse {
  id: string;
  status: FlyreqTaskStatus;
  mode?: FlyreqTaskMode;
  result?: { images?: string[]; sse?: FlyreqTaskSseResult };
  error?: string;
  warning?: string;
  createdAt?: string;
  completedAt?: string;
  expiresAt?: string;
}

export interface FlyreqQueueStatus {
  concurrencyLimit: number;
  configuredConcurrency: number;
  processingCount: number;
  queuedCount: number;
  pendingCount?: number;
  processingSlots?: number;
  queuedSlots?: number;
  pendingSlots?: number;
  maxQueueSize?: number;
  remainingQueueSlots?: number;
  displayConcurrency: number;
  displayQueued: number;
  acceptingNewTasks: boolean;
  rateLimitWindowMs?: number;
  rateLimitMaxRequestsPerIp?: number;
  rateLimitMaxRequestsPerApiKey?: number;
  retryAfterSeconds?: number;
  serverMessage?: string;
}

export interface ModelAvailabilityCheckTarget {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

export class FlyreqTaskError extends Error {
  statusCode: number;
  code?: string;
  retryAfter?: number;

  constructor(message: string, statusCode: number, code?: string, retryAfter?: number) {
    super(message);
    this.name = 'FlyreqTaskError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * 将图片模型配置转换为模型检查代理可消费的轻量对象，避免泄露与检查无关的表单状态。
 * @param model 已归一化的图片模型配置。
 * @returns 模型检查目标。
 */
function buildImageModelCheckTarget(model: ImageModelConfig): ModelAvailabilityCheckTarget {
  return {
    id: model.id,
    name: model.name,
    protocol: model.protocol,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    modelId: getResolvedImageModelId(model),
  };
}

/**
 * 将文本模型配置转换为模型检查代理可消费的轻量对象。
 * @param model 已归一化的文本模型配置。
 * @returns 模型检查目标。
 */
function buildTextModelCheckTarget(model: TextModelConfig): ModelAvailabilityCheckTarget {
  return {
    id: model.id,
    name: model.name,
    protocol: model.protocol,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    modelId: model.modelId,
  };
}

export interface FlyreqTaskAccess {
  taskId: string;
  readToken?: string;
}

export function normalizeFlyreqTaskAccess(access: FlyreqTaskAccess | string | null | undefined): FlyreqTaskAccess {
  if (typeof access === 'string') return { taskId: access };
  return {
    taskId: String(access?.taskId || ''),
    readToken: access?.readToken,
  };
}

interface CreateTaskResponse {
  taskId?: string;
  readToken?: string;
}

interface CreateTaskBatchResponse {
  taskIds?: string[];
  tasks?: Array<{ taskId?: string; readToken?: string }>;
}

interface AckTaskResponse {
  ok?: boolean;
  acknowledged?: boolean;
}

interface CancelTaskResponse {
  ok?: boolean;
  cancelled?: boolean;
}

function getObjectProperty(data: unknown, key: string): unknown {
  return typeof data === 'object' && data !== null && key in data
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

async function parseTaskResponse<T>(response: Response): Promise<T> {
  const data: unknown = await response.json().catch(() => null);
  if (
    response.status === 404 &&
    typeof data === 'object' &&
    data !== null &&
    getObjectProperty(data, 'status') === 'expired'
  ) {
    return data as T;
  }
  if (!response.ok) {
    const error = getObjectProperty(data, 'error');
    const code = getObjectProperty(data, 'code');
    const retryAfter = getObjectProperty(data, 'retryAfter');
    throw new FlyreqTaskError(
      typeof error === 'string' ? error : `任务请求失败: ${response.status}`,
      response.status,
      typeof code === 'string' ? code : undefined,
      typeof retryAfter === 'number' ? retryAfter : undefined,
    );
  }
  return data as T;
}

function collectModelIdsFromAvailabilityResponse(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const source = data as {
    id?: unknown;
    name?: unknown;
    model?: unknown;
    data?: Array<{ id?: unknown; model?: unknown; name?: unknown }>;
    models?: Array<{ id?: unknown; model?: unknown; name?: unknown }>;
  };
  const values: string[] = [];
  const pushModelId = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    values.push(trimmed);
    if (trimmed.startsWith('models/')) values.push(trimmed.slice('models/'.length));
  };

  pushModelId(source.id);
  pushModelId(source.model);
  pushModelId(source.name);

  const list = Array.isArray(source.data)
    ? source.data
    : Array.isArray(source.models)
      ? source.models
      : [];
  for (const item of list) {
    pushModelId(item?.id);
    pushModelId(item?.model);
    pushModelId(item?.name);
  }

  return values;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function buildCreateTaskBody(input: CreateFlyreqTaskInput): string {
  const body = JSON.stringify(input);
  const bodyBytes = new TextEncoder().encode(body).byteLength;
  if (bodyBytes > CREATE_TASK_MAX_BODY_BYTES) {
    throw new Error(`请求体过大（${formatByteSize(bodyBytes)}，上限 ${formatByteSize(CREATE_TASK_MAX_BODY_BYTES)}），请减少参考图数量或压缩后重试。`);
  }
  return body;
}

export function validateCreateFlyreqTaskBody(input: CreateFlyreqTaskInput): void {
  buildCreateTaskBody(input);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function buildTaskAccessUrl(pathname: string, readToken?: string): string {
  const token = String(readToken || '').trim();
  if (!token) return pathname;
  const separator = pathname.includes('?') ? '&' : '?';
  return `${pathname}${separator}token=${encodeURIComponent(token)}`;
}

function normalizeModelCheckError(error: unknown): Error {
  const errorMessage = getErrorMessage(error);
  const lowerMessage = errorMessage.toLowerCase();

  if (
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('abort') ||
    lowerMessage.includes('请求超时')
  ) {
    return new Error('模型检查超时，请稍后重试。');
  }

  if (
    lowerMessage.includes('failed to fetch') ||
    lowerMessage.includes('fetch failed') ||
    lowerMessage.includes('networkerror') ||
    lowerMessage.includes('network request failed') ||
    lowerMessage.includes('load failed') ||
    lowerMessage.includes('network connection was lost') ||
    lowerMessage.includes('econnreset') ||
    lowerMessage.includes('socket hang up') ||
    lowerMessage.includes('terminated')
  ) {
    return new Error('网络连接失败。请检查网络连接或稍后重试。');
  }

  return error instanceof Error ? error : new Error(errorMessage);
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = MODEL_CHECK_TIMEOUT,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error('请求超时');
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 创建一个兼容旧调用方的服务端生图任务。
 * @param input 单个服务端任务的完整请求参数。
 * @returns 新建服务端任务标识。
 */
export async function createFlyreqTask(input: CreateFlyreqTaskInput): Promise<FlyreqTaskAccess> {
  const body = buildCreateTaskBody(input);
  const response = await fetchWithTimeout('/api/flyreq/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }, CREATE_TASK_TIMEOUT);
  const data = await parseTaskResponse<CreateTaskResponse>(response);
  if (!data?.taskId) throw new Error('创建任务失败：后端未返回任务 ID');
  return { taskId: data.taskId, readToken: data.readToken };
}

/**
 * 原子创建多张图片对应的独立服务端任务。
 * @param input 多图提交参数，parallelCount 表示需要创建的独立任务数量。
 * @returns 按图片序号排序的服务端任务标识列表。
 */
export async function createFlyreqTasks(input: CreateFlyreqTaskInput): Promise<FlyreqTaskAccess[]> {
  const body = buildCreateTaskBody(input);
  const response = await fetchWithTimeout('/api/flyreq/tasks/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }, CREATE_TASK_TIMEOUT);
  const data = await parseTaskResponse<CreateTaskBatchResponse>(response);
  const tasks = Array.isArray(data?.tasks)
    ? data.tasks.map(task => normalizeFlyreqTaskAccess({ taskId: String(task?.taskId || ''), readToken: task?.readToken }))
    : Array.isArray(data?.taskIds)
      ? data.taskIds.map(taskId => normalizeFlyreqTaskAccess(taskId))
      : [];
  if (tasks.length !== input.parallelCount || tasks.some(task => !task.taskId)) {
    throw new Error('创建任务失败：后端未返回完整任务 ID 列表');
  }
  return tasks;
}

export async function checkModelsAvailability(
  targetModelIds?: string[],
  modelDrafts?: ModelAvailabilityCheckTarget[],
): Promise<ModelStatus[]> {
  try {
    const configuredModels = modelDrafts || (() => {
      const registry = loadRegistry();
      const completeImageModels = getCompleteImageModels(registry);
      const completeTextModels = getCompleteTextModels(registry);
      return [
        ...completeImageModels.map(buildImageModelCheckTarget),
        ...completeTextModels.map(buildTextModelCheckTarget),
      ];
    })();

    const filteredModels = targetModelIds && targetModelIds.length > 0
      ? configuredModels.filter((model) => targetModelIds.includes(model.id))
      : configuredModels;

    if (filteredModels.length === 0) {
      return [];
    }

    return Promise.all(filteredModels.map(async (model) => {
      try {
        const normalizedBaseUrl = normalizeModelBaseUrl(model.protocol, model.baseUrl);
        if (!normalizedBaseUrl || !model.apiKey || !model.modelId) {
          return {
            modelId: model.id,
            actualName: model.name,
            available: false,
            message: '模型配置不完整',
          };
        }

        // 统一通过后端代理使用 /v1/models（NewAPI 兼容），API Key 不放入 URL。
        const response = await fetchWithTimeout('/api/flyreq/proxy/models', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: normalizedBaseUrl,
            apiKey: model.apiKey,
            protocol: model.protocol,
            modelId: model.modelId,
          }),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          return {
            modelId: model.id,
            actualName: model.name,
            available: false,
            message: `${response.status}${detail ? ` ${detail.slice(0, 120)}` : ''}`,
          };
        }
        const data: unknown = await response.json().catch(() => ({}));
        const modelIds = collectModelIdsFromAvailabilityResponse(data);
        const exists = modelIds.includes(model.modelId);
        return {
          modelId: model.id,
          actualName: model.name,
          available: exists,
          message: exists ? model.modelId : `未在 /models 中找到 ${model.modelId}`,
        };
      } catch (error) {
        return {
          modelId: model.id,
          actualName: model.name,
          available: false,
          message: getErrorMessage(error),
        };
      }
    }));
  } catch (error) {
    throw normalizeModelCheckError(error);
  }
}

export function resolveImageTaskProvider(modelId: string): { apiKey: string; baseUrl: string; protocol: ProviderProtocol; modelId: string; imageApiFlavor?: ImageApiFlavor; streamImages?: boolean; supportsTemperature?: boolean } {
  const registry = loadRegistry();
  const model = getImageModelById(registry, modelId);
  if (!model) throw new Error(`未找到图片模型配置: ${modelId}`);
  const normalizedBaseUrl = normalizeModelBaseUrl(model.protocol, model.baseUrl);
  return {
    apiKey: model.apiKey,
    baseUrl: normalizedBaseUrl,
    protocol: model.protocol,
    modelId: getResolvedImageModelId(model),
    imageApiFlavor: getImageApiFlavor(model),
    streamImages: model.protocol === 'openai' ? Boolean(model.streamImages) : false,
    supportsTemperature: model.protocol === 'google' && model.supportsTemperature === true,
  };
}

export function resolveTextTaskProvider(modelId: string): { apiKey: string; baseUrl: string; protocol: ProviderProtocol } {
  const registry = loadRegistry();
  const model = getTextModelById(registry, modelId);
  if (!model) throw new Error(`未找到文本模型配置: ${modelId}`);
  const normalizedBaseUrl = normalizeModelBaseUrl(model.protocol, model.baseUrl);
  return {
    apiKey: model.apiKey,
    baseUrl: normalizedBaseUrl,
    protocol: model.protocol,
  };
}

export async function getFlyreqTask(taskId: string, readToken?: string): Promise<FlyreqTaskResponse> {
  const response = await fetchWithTimeout(buildTaskAccessUrl(`/api/flyreq/tasks/${encodeURIComponent(taskId)}`, readToken), {
    method: 'GET',
    cache: 'no-store',
  }, TASK_REQUEST_TIMEOUT);
  return parseTaskResponse(response);
}

export async function getFlyreqQueueStatus(): Promise<FlyreqQueueStatus> {
  const response = await fetchWithTimeout('/api/flyreq/queue-status', {
    method: 'GET',
    cache: 'no-store',
  }, TASK_REQUEST_TIMEOUT);
  return parseTaskResponse(response);
}

export async function ackFlyreqTask(taskId: string, readToken?: string): Promise<void> {
  const response = await fetchWithTimeout(buildTaskAccessUrl(`/api/flyreq/tasks/${encodeURIComponent(taskId)}/ack`, readToken), {
    method: 'POST',
  }, TASK_REQUEST_TIMEOUT);
  const data = await parseTaskResponse<AckTaskResponse>(response);
  if (!data?.acknowledged) {
    throw new Error('服务端未确认任务 ack');
  }
}

export async function cancelFlyreqTask(taskId: string, readToken?: string): Promise<void> {
  const response = await fetchWithTimeout(buildTaskAccessUrl(`/api/flyreq/tasks/${encodeURIComponent(taskId)}/cancel`, readToken), {
    method: 'POST',
  }, TASK_REQUEST_TIMEOUT);
  const data = await parseTaskResponse<CancelTaskResponse>(response);
  if (!data?.ok) {
    throw new Error('服务端未确认任务取消');
  }
}


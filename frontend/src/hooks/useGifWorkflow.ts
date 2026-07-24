'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createFlyreqTask, getFlyreqTask, normalizeFlyreqTaskAccess, resolveImageTaskProvider, validateCreateFlyreqTaskBody, type CreateFlyreqTaskInput, type ImageReference } from '@/lib/flyreq-task-client';
import { stripFlyreqImageReadTokenFromRef } from '@/lib/flyreq-image-fetch';
import { ackServerTaskWithRetry, cancelServerTaskWithRetry } from '@/lib/server-task-ack';
import { flyreqTaskSocket } from '@/lib/flyreq-task-socket';
import { generateUUID } from '@/lib/uuid';
import {
  downloadAndStoreImages,
  fetchImageAsBlob,
  resolveStoredImageRef,
  revokeBlobUrls,
  makeStoredBlobRef,
  deleteStoredBlobs,
} from '@/lib/image-downloader';
import type { RefImageData } from '@/lib/job-store';
import {
  GIF_GRID_ASPECT_RATIO,
  GIF_GRID_CUSTOM_SIZE,
  GIF_GRID_OUTPUT_SIZE,
  loadActiveGifJob,
  loadGifTemplate,
  saveActiveGifJob,
  type ActiveGifJob,
  type GifStatus,
} from '@/lib/gif-job-store';
import { buildGifPrompt } from '@/lib/gif-prompt';
import { encodeGifFromGrid, encodeFramesToGif, triggerGifDownload } from '@/lib/gif-encoder';
import {
  getGptImageAdvancedParamsForModel,
  type GptImageBackground,
  type GptImageOutputFormat,
  type GptImageQuality,
  type GptImageStyle,
} from '@/lib/model-capabilities';

export interface SubmitInput {
  prompt: string;
  loop: boolean;
  closedLoop: boolean;
  model: string;
  gptImageQuality: GptImageQuality;
  gptImageStyle: GptImageStyle;
  gptImageBackground: GptImageBackground;
  gptImageOutputFormat: GptImageOutputFormat;
  refImages: RefImageData[];
  frameDelayMs: number;
  loopCount: number;
  framePadding: number;
}

export interface UseGifWorkflowResult {
  job: ActiveGifJob | null;
  gridImageUrl: string | null;
  gifBlob: Blob | null;
  gifReady: boolean;
  startedAt: number | null;
  isApiKeyMissing: boolean;
  isSyncing: boolean;
  submitGrid: (input: SubmitInput) => Promise<void>;
  encodeGif: (params: GifEncodeParams) => Promise<void>;
  encodeTunedGif: (frames: ImageData[], params: GifEncodeParams) => void;
  downloadGif: () => void;
  resetJob: () => Promise<void>;
  refreshFromServer: (onStatus?: (message: string) => void) => Promise<void>;
  updateJobStatus: (status: GifStatus) => void;
}

export interface GifEncodeParams {
  loop: boolean;
  frameDelayMs: number;
  loopCount: number;
  framePadding: number;
}

export interface GifGridImageStorageResult {
  gridImageRef: string;
  immediateBlobUrl: string | null;
  shouldAckServerTask: boolean;
}

function buildImageReferences(template: { data: string; mimeType: string }, refs: RefImageData[]): ImageReference[] {
  const result: ImageReference[] = [{ data: template.data, mimeType: template.mimeType || 'image/png' }];
  for (const ref of refs) {
    const base64 = ref.dataUrl.includes(',') ? ref.dataUrl.split(',')[1] : ref.dataUrl;
    result.push({ data: base64, mimeType: ref.mimeType || 'image/png' });
  }
  return result;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function cacheGifGridImage(jobId: string, imageRef: string, readToken?: string): Promise<GifGridImageStorageResult> {
  if (!imageRef.startsWith('URL:')) {
    return {
      gridImageRef: imageRef,
      immediateBlobUrl: imageRef.startsWith('blob:') ? imageRef : null,
      shouldAckServerTask: true,
    };
  }

  try {
    const result = await downloadAndStoreImages(jobId, [imageRef], { readToken });
    if (result.successCount > 0 && result.blobUrls[0]) {
      return {
        gridImageRef: makeStoredBlobRef(jobId, 0),
        immediateBlobUrl: result.blobUrls[0],
        shouldAckServerTask: true,
      };
    }
  } catch {
    // 下载失败时保留远程 URL，服务端任务不能提前 ack，避免图片过早清理。
  }

  return {
    gridImageRef: stripFlyreqImageReadTokenFromRef(imageRef),
    immediateBlobUrl: null,
    shouldAckServerTask: false,
  };
}

export function useGifWorkflow(): UseGifWorkflowResult {
  const [job, setJobState] = useState<ActiveGifJob | null>(null);
  const [gridImageUrl, setGridImageUrl] = useState<string | null>(null);
  const [gifBlob, setGifBlob] = useState<Blob | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [isApiKeyMissing, setIsApiKeyMissing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const jobRef = useRef<ActiveGifJob | null>(null);
  const subscriptionRef = useRef<(() => void) | null>(null);
  const resolvedBlobUrlsRef = useRef<string[]>([]);

  const setVolatileJob = useCallback((next: ActiveGifJob | null) => {
    jobRef.current = next;
    setJobState(next);
  }, []);

  const persistJob = useCallback((next: ActiveGifJob | null) => {
    if (!saveActiveGifJob(next)) {
      throw new Error('浏览器本地持久存储不可用');
    }
    setVolatileJob(next);
  }, [setVolatileJob]);

  const markRecoverableGridSyncFailure = useCallback((target: ActiveGifJob, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const recoverable: ActiveGifJob = {
      ...target,
      status: 'generating_grid',
      error: `${message}。生成结果未完成本地保存，服务端任务仍保留，可点击刷新重试。`,
      updatedAt: nowIso(),
    };
    try {
      persistJob(recoverable);
    } catch {
      setVolatileJob(recoverable);
    }
  }, [persistJob, setVolatileJob]);

  const markFailedServerGridTask = useCallback(async (
    target: ActiveGifJob,
    task: { status?: string; error?: string; warning?: string },
    serverTaskId: string,
    serverTaskReadToken?: string,
  ) => {
    const error = task.error || task.warning || (task.status === 'expired' ? '璇ヤ换鍔″凡瓒呭嚭鍙栧洖鏃堕棿' : '鍚庣浠诲姟澶辫触');
    const failed: ActiveGifJob = {
      ...target,
      status: 'failed',
      error,
      serverTaskAcked: false,
      updatedAt: nowIso(),
    };
    try {
      persistJob(failed);
    } catch {
      setVolatileJob(failed);
      return;
    }

    const acked = await ackServerTaskWithRetry(serverTaskId, serverTaskReadToken);
    if (jobRef.current?.id !== target.id || jobRef.current.serverTaskId !== serverTaskId) return;
    if (!acked) return;

    const acknowledged: ActiveGifJob = {
      ...failed,
      serverTaskAcked: true,
      serverTaskReadToken: undefined,
      updatedAt: nowIso(),
    };
    try {
      persistJob(acknowledged);
    } catch {
      setVolatileJob(acknowledged);
    }
  }, [persistJob, setVolatileJob]);

  const updateJob = useCallback((updater: (prev: ActiveGifJob) => ActiveGifJob) => {
    const current = jobRef.current;
    if (!current) return;
    const next = updater(current);
    persistJob(next);
  }, [persistJob]);

  const clearSubscription = useCallback(() => {
    if (subscriptionRef.current) {
      try { subscriptionRef.current(); } catch { /* ignore */ }
      subscriptionRef.current = null;
    }
  }, []);

  const revokeResolvedUrls = useCallback(() => {
    if (resolvedBlobUrlsRef.current.length > 0) {
      revokeBlobUrls(resolvedBlobUrlsRef.current);
      resolvedBlobUrlsRef.current = [];
    }
  }, []);

  const loadGridImageUrl = useCallback(async (target: ActiveGifJob): Promise<string | null> => {
    const ref = target.gridImageRef;
    if (!ref) return null;
    if (ref.startsWith('URL:')) {
      const src = ref.substring(4);
      if (!target.serverTaskReadToken) return src;
      try {
        const blob = await fetchImageAsBlob(src, 1, undefined, { readToken: target.serverTaskReadToken });
        const blobUrl = URL.createObjectURL(blob);
        resolvedBlobUrlsRef.current.push(blobUrl);
        return blobUrl;
      } catch {
        return null;
      }
    }
    if (ref.startsWith('IDB:') || ref.startsWith('blob:')) {
      const resolved = await resolveStoredImageRef(target.id, ref, 0);
      if (resolved.blobUrl) {
        resolvedBlobUrlsRef.current.push(resolved.blobUrl);
      }
      return resolved.image && resolved.image !== ref ? resolved.image : null;
    }
    return ref;
  }, []);

  const finalizeGrid = useCallback(async (
    target: ActiveGifJob,
    images: string[],
    serverTaskId: string,
    serverTaskReadToken?: string,
  ): Promise<void> => {
    const first = images[0];
    if (!first) {
      persistJob({
        ...target,
        status: 'failed',
        error: '后端返回的图片为空',
        updatedAt: nowIso(),
      });
      return;
    }

    const storage = await cacheGifGridImage(target.id, first, serverTaskReadToken);

    const completed: ActiveGifJob = {
      ...target,
      status: 'review_grid',
      gridImageRef: storage.gridImageRef,
      serverTaskAcked: false,
      error: storage.shouldAckServerTask ? undefined : '网格图本地缓存失败，暂时使用服务端远程图片。服务端任务仍保留，可点击主动同步状态重试本地缓存。',
      updatedAt: nowIso(),
    };
    persistJob(completed);

    if (storage.shouldAckServerTask) {
      const acked = await ackServerTaskWithRetry(serverTaskId, serverTaskReadToken);
      if (jobRef.current?.id !== target.id) return;
      if (!acked) {
        persistJob({
          ...completed,
          serverTaskAcked: false,
          error: '服务端清理确认失败，任务仍保留，可稍后主动同步状态重试。',
          updatedAt: nowIso(),
        });
      } else {
        persistJob({
          ...completed,
          serverTaskAcked: true,
          serverTaskReadToken: undefined,
          updatedAt: nowIso(),
        });
      }
    }

    revokeResolvedUrls();
    if (storage.immediateBlobUrl) {
      resolvedBlobUrlsRef.current.push(storage.immediateBlobUrl);
      setGridImageUrl(storage.immediateBlobUrl);
    } else {
      const url = await loadGridImageUrl(completed);
      setGridImageUrl(url);
    }
  }, [persistJob, revokeResolvedUrls, loadGridImageUrl]);

  const subscribeServerTask = useCallback((taskId: string, readToken?: string) => {
    clearSubscription();
    const unsubscribe = flyreqTaskSocket.subscribeTask(taskId, readToken, task => {
      const current = jobRef.current;
      if (!current || current.serverTaskId !== taskId) return;
      if (task.status === 'completed') {
        const images = task.result?.images || [];
        void finalizeGrid(current, images, taskId, current.serverTaskReadToken)
          .then(clearSubscription)
          .catch(error => markRecoverableGridSyncFailure(current, error));
        return;
      }
      if (task.status === 'failed' || task.status === 'expired') {
        void markFailedServerGridTask(current, task, taskId, current.serverTaskReadToken)
          .finally(clearSubscription);
        return;
      }
      if (task.status === 'processing' || task.status === 'queued' || task.status === '排队中') {
        if (current.status !== 'generating_grid') {
          persistJob({ ...current, status: 'generating_grid', updatedAt: nowIso() });
        }
      }
    });
    subscriptionRef.current = unsubscribe;
  }, [clearSubscription, finalizeGrid, markFailedServerGridTask, markRecoverableGridSyncFailure, persistJob]);

  /**
   * 挂载时恢复本地 GIF 任务，并在组件卸载后阻止旧异步请求恢复订阅或写入状态。
   * @returns 清理函数会标记初始化流程已取消。
   */
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const initial = loadActiveGifJob();
      if (!initial) {
        setIsApiKeyMissing(false);
        return;
      }
      jobRef.current = initial;
      setJobState(initial);

    if (initial.gridImageRef) {
      void loadGridImageUrl(initial).then(url => {
        if (!cancelled) setGridImageUrl(url);
      });
    }

    if (initial.status === 'generating_grid' && initial.serverTaskId) {
      setStartedAt(Date.parse(initial.createdAt) || Date.now());
      getFlyreqTask(initial.serverTaskId, initial.serverTaskReadToken)
        .then(task => {
          if (cancelled) return;
          const current = jobRef.current;
          if (!current || current.serverTaskId !== initial.serverTaskId) return;
          if (task.status === 'completed') {
            void finalizeGrid(current, task.result?.images || [], initial.serverTaskId!, current.serverTaskReadToken)
              .catch(error => {
                if (!cancelled) markRecoverableGridSyncFailure(current, error);
              });
          } else if (task.status === 'failed' || task.status === 'expired') {
            void markFailedServerGridTask(current, task, initial.serverTaskId!, current.serverTaskReadToken);
          } else {
            subscribeServerTask(initial.serverTaskId!, initial.serverTaskReadToken);
          }
        })
        .catch(() => {
          if (!cancelled) subscribeServerTask(initial.serverTaskId!, initial.serverTaskReadToken);
        });
    }

      setIsApiKeyMissing(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 恢复流程仅应在挂载时运行，所用回调在本实例生命周期内保持稳定。
  }, []);

  useEffect(() => {
    return () => {
      clearSubscription();
      revokeResolvedUrls();
    };
  }, [clearSubscription, revokeResolvedUrls]);

  const cleanupJobAssets = useCallback(async (target: ActiveGifJob | null) => {
    if (!target) return;
    try {
      await deleteStoredBlobs(target.id, 1);
    } catch {
      // ignore cleanup error
    }
  }, []);

  const cancelGifServerTask = useCallback((target: ActiveGifJob | null | undefined) => {
    if (!target?.serverTaskId || target.serverTaskAcked === true) return;
    void cancelServerTaskWithRetry(target.serverTaskId, target.serverTaskReadToken);
  }, []);

  const submitGrid = useCallback(async (input: SubmitInput) => {
    let provider;
    try {
      provider = resolveImageTaskProvider(input.model);
    } catch {
      setIsApiKeyMissing(true);
      throw new Error('请先完成 GIF 图片模型配置');
    }
    if (!provider.apiKey || !provider.baseUrl) {
      setIsApiKeyMissing(true);
      throw new Error('请先完成 GIF 图片模型配置');
    }
    setIsApiKeyMissing(false);

    const previousJob = jobRef.current;

    const template = await loadGifTemplate();
    const refsForSubmit = input.refImages.slice(0, 6);
    const advancedParams = getGptImageAdvancedParamsForModel(input.model, {
      quality: input.gptImageQuality,
      style: input.gptImageStyle,
      background: input.gptImageBackground,
      outputFormat: input.gptImageOutputFormat,
    });
    const finalPrompt = buildGifPrompt({
      userPrompt: input.prompt,
      refImageCount: refsForSubmit.length,
      loop: input.loop,
      closedLoop: input.closedLoop,
    });
    const taskPayload = {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      imageApiFlavor: provider.imageApiFlavor,
      mode: 'image-to-image',
      prompt: finalPrompt,
      outputSize: GIF_GRID_OUTPUT_SIZE,
      customSize: GIF_GRID_CUSTOM_SIZE,
      aspectRatio: GIF_GRID_ASPECT_RATIO,
      temperature: 1,
      model: provider.modelId,
      gptImageQuality: advancedParams.quality,
      gptImageStyle: advancedParams.style,
      gptImageBackground: advancedParams.background,
      gptImageOutputFormat: advancedParams.outputFormat,
      streamImages: provider.streamImages,
      parallelCount: 1,
      images: buildImageReferences(template, refsForSubmit),
    } satisfies CreateFlyreqTaskInput;
    validateCreateFlyreqTaskBody(taskPayload);

    const next: ActiveGifJob = {
      id: generateUUID(),
      status: 'generating_grid',
      prompt: input.prompt,
      loop: input.loop,
      closedLoop: input.closedLoop,
      model: input.model,
      gptImageQuality: advancedParams.quality,
      gptImageStyle: advancedParams.style,
      gptImageBackground: advancedParams.background,
      gptImageOutputFormat: advancedParams.outputFormat,
      refImages: refsForSubmit,
      frameDelayMs: input.frameDelayMs,
      loopCount: input.loopCount,
      framePadding: input.framePadding,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    if (!previousJob) {
      persistJob(next);
      setStartedAt(Date.now());
    }

    let createdServerTaskId: string | null = null;
    let createdServerTaskReadToken: string | undefined;
    try {
      const serverTask = normalizeFlyreqTaskAccess(await createFlyreqTask(taskPayload));
      createdServerTaskId = serverTask.taskId;
      createdServerTaskReadToken = serverTask.readToken;

      const withTaskId: ActiveGifJob = {
        ...next,
        serverTaskId: serverTask.taskId,
        serverTaskReadToken: serverTask.readToken,
        updatedAt: nowIso(),
      };
      persistJob(withTaskId);
      clearSubscription();
      if (previousJob) {
        cancelGifServerTask(previousJob);
        void cleanupJobAssets(previousJob);
        setStartedAt(Date.now());
      }
      revokeResolvedUrls();
      setGridImageUrl(null);
      setGifBlob(null);
      subscribeServerTask(serverTask.taskId, serverTask.readToken);
    } catch (error) {
      if (createdServerTaskId) {
        void cancelServerTaskWithRetry(createdServerTaskId, createdServerTaskReadToken);
      }
      if (jobRef.current?.id !== next.id) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      const failedJob: ActiveGifJob = {
        ...next,
        ...(createdServerTaskId ? { serverTaskId: createdServerTaskId } : {}),
        status: 'failed',
        error: createdServerTaskId ? `${message}（任务 ID：${createdServerTaskId}）` : message,
        updatedAt: nowIso(),
      };
      try {
        persistJob(failedJob);
      } catch {
        setVolatileJob(failedJob);
      }
      throw error;
    }
  }, [cancelGifServerTask, cleanupJobAssets, clearSubscription, persistJob, revokeResolvedUrls, setVolatileJob, subscribeServerTask]);

  const encodeGif = useCallback(async (params: GifEncodeParams) => {
    const current = jobRef.current;
    if (!current || current.status !== 'review_grid') return;
    let imageUrl = gridImageUrl;
    if (!imageUrl) {
      imageUrl = await loadGridImageUrl(current);
      if (imageUrl) setGridImageUrl(imageUrl);
    }
    if (!imageUrl) {
      updateJob(prev => ({ ...prev, status: 'failed', error: '无法读取网格图，请重新生成', updatedAt: nowIso() }));
      return;
    }

    // 更新 job 中的 GIF 参数
    updateJob(prev => ({
      ...prev,
      status: 'generating_gif',
      error: undefined,
      loop: params.loop,
      frameDelayMs: params.frameDelayMs,
      loopCount: params.loopCount,
      framePadding: params.framePadding,
      updatedAt: nowIso(),
    }));

    try {
      const repeat = params.loop ? Math.max(0, Math.floor(params.loopCount)) : -1;
      const blob = await encodeGifFromGrid(imageUrl, {
        frameDelayMs: params.frameDelayMs,
        repeat,
        framePaddingPercent: params.framePadding,
      });
      setGifBlob(blob);
      triggerGifDownload(blob, `gif-${current.id}.gif`);
      updateJob(prev => ({ ...prev, status: 'done', updatedAt: nowIso() }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateJob(prev => ({ ...prev, status: 'failed', error: message, updatedAt: nowIso() }));
    }
  }, [gridImageUrl, loadGridImageUrl, updateJob]);

  const encodeTunedGif = useCallback((frames: ImageData[], params: GifEncodeParams) => {
    const current = jobRef.current;
    if (!current) return;
    updateJob(prev => ({
      ...prev,
      status: 'generating_gif',
      error: undefined,
      loop: params.loop,
      frameDelayMs: params.frameDelayMs,
      loopCount: params.loopCount,
      framePadding: params.framePadding,
      updatedAt: nowIso(),
    }));
    try {
      const repeat = params.loop ? Math.max(0, Math.floor(params.loopCount)) : -1;
      const blob = encodeFramesToGif(frames, {
        frameDelayMs: params.frameDelayMs,
        repeat,
      });
      setGifBlob(blob);
      triggerGifDownload(blob, `gif-${current.id}.gif`);
      updateJob(prev => ({ ...prev, status: 'done', updatedAt: nowIso() }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateJob(prev => ({ ...prev, status: 'failed', error: message, updatedAt: nowIso() }));
    }
  }, [updateJob]);

  const downloadGif = useCallback(() => {
    const current = jobRef.current;
    if (!gifBlob || !current) return;
    triggerGifDownload(gifBlob, `gif-${current.id}.gif`);
  }, [gifBlob]);

  const updateJobStatus = useCallback((status: GifStatus) => {
    updateJob(prev => ({ ...prev, status, updatedAt: nowIso() }));
  }, [updateJob]);

  const resetJob = useCallback(async () => {
    const previous = jobRef.current;
    clearSubscription();
    cancelGifServerTask(previous);
    revokeResolvedUrls();
    setGridImageUrl(null);
    setGifBlob(null);
    setStartedAt(null);
    persistJob(null);
    await cleanupJobAssets(previous);
  }, [cancelGifServerTask, cleanupJobAssets, clearSubscription, persistJob, revokeResolvedUrls]);

  const refreshFromServer = useCallback(async (onStatus?: (message: string) => void) => {
    const current = jobRef.current;
    if (!current?.serverTaskId || isSyncing) return;
    setIsSyncing(true);
    onStatus?.('正在查询任务状态…');
    try {
      const task = await getFlyreqTask(current.serverTaskId, current.serverTaskReadToken);
      if (task.status === 'completed') {
        onStatus?.('生成完成，正在下载图片…');
        await finalizeGrid(current, task.result?.images || [], current.serverTaskId, current.serverTaskReadToken);
      } else if (task.status === 'failed' || task.status === 'expired') {
        const errorMsg = task.error || task.warning || (task.status === 'expired' ? '该任务已超出取回时间' : '后端任务失败');
        await markFailedServerGridTask(current, task, current.serverTaskId, current.serverTaskReadToken);
        onStatus?.(`任务失败：${errorMsg}`);
      } else if (task.status === 'processing') {
        persistJob({ ...current, status: 'generating_grid', updatedAt: nowIso() });
        onStatus?.('任务正在生成中，请稍候…');
      } else if (task.status === 'queued' || task.status === '排队中') {
        persistJob({ ...current, status: 'generating_grid', updatedAt: nowIso() });
        onStatus?.('任务排队中，请耐心等待…');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      persistJob({
        ...current,
        status: 'generating_grid',
        error: `${message}。查询任务状态失败，服务端任务仍保留，可稍后刷新重试。`,
        updatedAt: nowIso(),
      });
      subscribeServerTask(current.serverTaskId, current.serverTaskReadToken);
      onStatus?.(`查询失败：${message}`);
    } finally {
      setIsSyncing(false);
    }
  }, [finalizeGrid, isSyncing, markFailedServerGridTask, persistJob, subscribeServerTask]);

  const gifReady: boolean = !!job && job.status === 'done';

  return {
    job,
    gridImageUrl,
    gifBlob,
    gifReady,
    startedAt,
    isApiKeyMissing,
    isSyncing,
    submitGrid,
    encodeGif,
    encodeTunedGif,
    downloadGif,
    resetJob,
    refreshFromServer,
    updateJobStatus,
  };
}

export type { GifStatus };

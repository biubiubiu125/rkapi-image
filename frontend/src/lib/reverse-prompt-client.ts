// 反推提示词的前端直连流式客户端
// 根据模型分发：
//   - gpt-5.4-mini          → POST /v1/responses          （OpenAI Responses API + reasoning.high）
//   - gemini-2.5-flash      → POST /v1beta/.../streamGenerateContent?alt=sse （Google 原生流式）
// 所有请求直接从浏览器发到外部 API（baseUrl 参数指定），不经过我们自己的服务器。

import {
  REVERSE_PROMPT_TEMPLATES,
  type ReversePromptMode,
  type ReversePromptModelId,
} from '@/lib/reverse-prompt-config';
import { getConfiguredTextModel } from '@/lib/model-endpoints';
import { readSseStream } from '@/lib/sse-stream-parser';

export interface StreamReverseInput {
  apiKey: string;
  model: ReversePromptModelId;
  mode: ReversePromptMode;
  imageDataUrl: string;
  mimeType: string;
}

export interface StreamReverseCallbacks {
  onDelta(token: string): void;
  onDone(fullText: string): void;
  onError(err: Error): void;
}

export interface StreamReverseHandle {
  abort(): void;
  promise: Promise<void>;
}

/**
 * 启动一次反推提示词流式请求。
 * 返回的 handle.abort() 可随时取消。
 * 任何错误都通过 callbacks.onError 上报，promise 永远 resolve（不会 reject）。
 */
export function streamReversePrompt(
  input: StreamReverseInput,
  callbacks: StreamReverseCallbacks,
  baseUrl: string = '',
): StreamReverseHandle {
  const controller = new AbortController();

  const promise = (async () => {
    try {
      const configuredModel = getConfiguredTextModel(input.model);
      const protocol = configuredModel?.protocol;
      const resolvedBaseUrl = configuredModel?.baseUrl || baseUrl;
      const resolvedModelId = configuredModel?.modelId || input.model;
      if (protocol === 'openai') {
        await streamOpenAiResponses(resolvedBaseUrl, { ...input, model: resolvedModelId }, callbacks, controller.signal);
      } else if (protocol === 'google') {
        await streamGeminiGenerateContent(resolvedBaseUrl, { ...input, model: resolvedModelId }, callbacks, controller.signal);
      } else {
        throw new Error(`暂不支持的反推模型协议: ${String(protocol || 'unknown')}`);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      callbacks.onError(normalizeStreamError(err));
    }
  })();

  return {
    abort: () => controller.abort(),
    promise,
  };
}

// ===== OpenAI Responses API（GPT 走 /v1/responses） =====

interface OpenAiResponsesEventEnvelope {
  type?: string;
  delta?: string;
  text?: string;
  response?: { output_text?: string };
  error?: { message?: string };
  message?: string;
}

async function streamOpenAiResponses(
  baseUrl: string,
  input: StreamReverseInput,
  callbacks: StreamReverseCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const body = {
    model: input.model,
    stream: true,
    reasoning: { effort: 'high' as const },
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: REVERSE_PROMPT_TEMPLATES[input.mode] },
          { type: 'input_image', image_url: input.imageDataUrl },
        ],
      },
    ],
  };

  const response = await fetch('/api/nova/proxy/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol: 'openai',
      baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      stream: true,
      requestBody: body,
    }),
    signal,
  });

  if (!response.ok) {
    throw await readHttpError(response);
  }
  if (!response.body) {
    throw new Error('响应没有可读流');
  }

  let accumulated = '';
  let fired = false;

  const fireDone = () => {
    if (fired) return;
    fired = true;
    callbacks.onDone(accumulated);
  };

  await readSseStream(response.body, signal, (event) => {
    if (!event.data) return;
    if (event.data === '[DONE]') {
      fireDone();
      return;
    }

    let payload: OpenAiResponsesEventEnvelope;
    try {
      payload = JSON.parse(event.data) as OpenAiResponsesEventEnvelope;
    } catch {
      return;
    }

    const eventType = payload.type || event.event || '';

    if (eventType === 'response.output_text.delta') {
      const delta = typeof payload.delta === 'string' ? payload.delta : '';
      if (delta) {
        accumulated += delta;
        callbacks.onDelta(delta);
      }
      return;
    }

    if (eventType === 'response.output_text.done') {
      // 用 text 字段做兜底，确保最终全文不丢
      if (typeof payload.text === 'string' && payload.text.length > accumulated.length) {
        const tail = payload.text.slice(accumulated.length);
        if (tail) {
          accumulated = payload.text;
          callbacks.onDelta(tail);
        }
      }
      return;
    }

    if (eventType === 'response.completed') {
      const fullText = payload.response?.output_text;
      if (typeof fullText === 'string' && fullText.length > accumulated.length) {
        const tail = fullText.slice(accumulated.length);
        if (tail) {
          accumulated = fullText;
          callbacks.onDelta(tail);
        }
      }
      fireDone();
      return;
    }

    if (eventType === 'error' || eventType === 'response.error') {
      const message = payload.error?.message || payload.message || '模型返回错误';
      throw new Error(message);
    }
  });

  fireDone();
}

// ===== Google Gemini 原生 API（Gemini 走 /v1beta） =====

interface GeminiPart {
  text?: string;
  thought?: boolean;
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiStreamChunk {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

async function streamGeminiGenerateContent(
  baseUrl: string,
  input: StreamReverseInput,
  callbacks: StreamReverseCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const { base64, mimeType } = parseDataUrl(input.imageDataUrl, input.mimeType);

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: REVERSE_PROMPT_TEMPLATES[input.mode] },
          { inline_data: { mime_type: mimeType, data: base64 } },
        ],
      },
    ],
    generationConfig: {
      thinkingConfig: {
        thinkingBudget: -1,
        includeThoughts: false,
      },
    },
  };

  const response = await fetch('/api/nova/proxy/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol: 'google',
      baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      stream: true,
      requestBody: body,
    }),
    signal,
  });

  if (!response.ok) {
    throw await readHttpError(response);
  }
  if (!response.body) {
    throw new Error('响应没有可读流');
  }

  let accumulated = '';
  let fired = false;
  const fireDone = () => {
    if (fired) return;
    fired = true;
    callbacks.onDone(accumulated);
  };

  await readSseStream(response.body, signal, (event) => {
    if (!event.data) return;
    if (event.data === '[DONE]') {
      fireDone();
      return;
    }

    let chunk: GeminiStreamChunk;
    try {
      chunk = JSON.parse(event.data) as GeminiStreamChunk;
    } catch {
      return;
    }

    if (chunk.error?.message) {
      throw new Error(chunk.error.message);
    }
    if (chunk.promptFeedback?.blockReason) {
      throw new Error(`内容被拦截: ${chunk.promptFeedback.blockReason}`);
    }

    const candidates = chunk.candidates || [];
    for (const candidate of candidates) {
      const parts = candidate.content?.parts || [];
      for (const part of parts) {
        // 跳过模型的内部思考片段（thought=true），只把正文输出给用户
        if (part.thought === true) continue;
        const text = part.text;
        if (typeof text === 'string' && text.length > 0) {
          accumulated += text;
          callbacks.onDelta(text);
        }
      }
    }
  });

  fireDone();
}

// ===== 工具函数 =====

function parseDataUrl(dataUrl: string, fallbackMime: string): { base64: string; mimeType: string } {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/);
  if (match) {
    return { mimeType: match[1] || fallbackMime || 'image/jpeg', base64: match[2] };
  }
  // 不是 data URL，尝试当作纯 base64
  return { mimeType: fallbackMime || 'image/jpeg', base64: dataUrl };
}

async function readHttpError(response: Response): Promise<Error> {
  let detail = '';
  try {
    detail = await response.text();
  } catch {
    // ignore
  }
  // 尝试解析 JSON 里的 error.message
  if (detail) {
    try {
      const parsed = JSON.parse(detail);
      const message =
        parsed?.error?.message
        || parsed?.error
        || parsed?.message;
      if (typeof message === 'string' && message.length > 0) {
        return new Error(`${response.status} ${response.statusText}: ${message}`);
      }
    } catch {
      // 不是 JSON
    }
  }
  return new Error(`${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
}

function normalizeStreamError(error: unknown): Error {
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      lower.includes('failed to fetch')
      || lower.includes('network')
      || lower.includes('load failed')
      || lower.includes('econnreset')
      || lower.includes('terminated')
    ) {
      return new Error('网络连接失败，请检查网络后重试');
    }
    return error;
  }
  return new Error(String(error));
}

const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { WebSocketServer } = require('ws');
const { createXaiImagineRequestInit, getXaiImagineEndpoint } = require('./xai-imagine');

const ENV_FILE_PATHS = [...new Set([
  path.join(__dirname, '.env'),
  path.join(process.cwd(), '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, 'data', '.env'),
])];
const RUNTIME_ENV_VALUE_KEYS = new Set([
  'TRUSTED_PROXY_IPS',
  'TASK_CONCURRENCY',
  'MAX_QUEUE_SIZE',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX_REQUESTS_PER_IP',
  'RATE_LIMIT_MAX_REQUESTS_PER_API_KEY',
  'MAX_PENDING_TASKS_PER_IP',
  'MAX_PENDING_TASKS_PER_API_KEY',
  'RATE_LIMIT_RETRY_AFTER_SECONDS',
  'BASE_URL_REWRITE_MAP',
  'OUTBOUND_USER_AGENT',
  'PLATFORM_NAME',
  'PLATFORM_LOGO_URL',
  'PLATFORM_ICON_URL',
  'PLATFORM_ICON_192_URL',
  'PLATFORM_ICON_512_URL',
  'PLATFORM_MASKABLE_ICON_URL',
  'IMAGE_MODEL_KEY_GUIDE_TITLE',
  'IMAGE_MODEL_KEY_GUIDE_DESCRIPTION',
  'IMAGE_MODEL_KEY_GUIDE_CTA_LABEL',
  'IMAGE_MODEL_KEY_GUIDE_URL',
  'DEFAULT_IMAGE_MODEL_PRESET',
  'DEFAULT_IMAGE_MODEL_PROTOCOL',
  'DEFAULT_IMAGE_MODEL_MODEL_ID',
  'DEFAULT_IMAGE_MODEL_MAX_REF_IMAGES',
  'DEFAULT_IMAGE_MODEL_SUPPORTS_ADVANCED_PARAMS',
  'DEFAULT_IMAGE_MODEL_SUPPORTS_TEMPERATURE',
  'DEFAULT_IMAGE_MODEL_STREAM_IMAGES',
  'IMAGE_PRESET_MODEL_IDS',
  'REJECT_NEW_TASKS',
  'ACCEPT_NEW_TASKS',
]);
const RUNTIME_DIRECT_ENV_KEYS = new Set([
  'PROMPT_GALLERY_MODE',
  'PROMPT_GALLERY_PASSWORD',
]);
const TASK_STATUS = {
  QUEUED: '排队中',
  LEGACY_QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
};
const GLOBAL_TASK_CONCURRENCY = 50;
const MAX_PARALLEL_COUNT = 20;
const DEFAULT_LIMIT_CONFIG = {
  maxQueueSize: 200,
  rateLimitWindowMs: 60 * 1000,
  maxRequestsPerIp: 20,
  maxRequestsPerApiKey: 20,
  maxPendingTasksPerIp: 20,
  maxPendingTasksPerApiKey: 20,
  retryAfterSeconds: 30,
};
const LIMIT_ERROR_MESSAGES = {
  queueFull: '当前排队任务较多，请稍后再试。',
  rateLimited: '请求太频繁，请稍后再试。',
  tooManyPending: '你已有较多任务正在排队或生成，请稍后再提交。',
  notAcceptingTasks: '服务器正在升级维护，暂不接受新任务。未完成任务将继续完成。',
};
const DEFAULT_IMAGE_MODEL_KEY_GUIDE = {
  title: '还没有图片模型 API Key？',
  description: '默认已为你准备 RKAPI 图片模型，填入 API Key 后保存即可开始生成图片。',
  ctaLabel: '打开 RKAPI',
  url: 'https://api.rkai6.com',
};
function readPackageVersion(packagePath) {
  try {
    const version = require(packagePath).version;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

function resolveAppVersion() {
  if (typeof process.env.APP_VERSION === 'string' && process.env.APP_VERSION.trim()) {
    return process.env.APP_VERSION.trim();
  }
  return readPackageVersion(path.join(__dirname, '..', 'package.json'))
    || readPackageVersion(path.join(__dirname, 'package.json'))
    || '0.0.0';
}

const APP_VERSION = resolveAppVersion();
const DEFAULT_PLATFORM_BRANDING = {
  platformName: 'RKAPI Image',
  logoUrl: '/favicon.png',
  iconUrl: '/favicon.png',
  icon192Url: '/icon-192.png',
  icon512Url: '/icon-512.png',
  maskableIconUrl: '/icon-maskable-512.png',
  platformVersion: APP_VERSION,
};
const DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG = {
  id: 'rkapi-4k-image',
  protocol: 'openai',
  name: 'RKAPI-4k',
  modelId: 'gpt-image-2',
  usesPresetModelId: false,
  baseUrl: 'https://api.rkai6.com',
  builtinPreset: 'gpt-image-2',
  maxRefImages: 16,
  maxOutputSize: '4K',
  supportsAdvancedParams: true,
  supportsTemperature: false,
  streamImages: true,
};
const BUILTIN_IMAGE_PRESET_IDS = new Set([
  'gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview',
  'gemini-3.1-flash-lite-image', 'gpt-image-2', 'grok-imagine-image', 'grok-imagine-image-quality',
]);
const RKAPI_GATEWAY_BASE_URL = 'https://api.rkai6.com';
const DEFAULT_OUTBOUND_USER_AGENT = `RKAPI-Image/${APP_VERSION}`;
const MAX_REMOTE_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_REMOTE_IMAGE_REDIRECTS = 5;
const MAX_UPSTREAM_ERROR_BODY_CHARS = 1000;
const MAX_UPSTREAM_ERROR_MESSAGE_CHARS = 1200;

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  if (!fs.statSync(filePath).isFile()) return {};

  const values = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    values[key] = value;
  }
  return values;
}

/**
 * 合并后端目录、项目根目录与持久化数据目录的环境变量文件。
 * @returns 后加载文件覆盖先加载文件后的环境变量对象。
 */
function parseEnvFiles() {
  return ENV_FILE_PATHS.reduce((values, filePath) => ({ ...values, ...parseEnvFile(filePath) }), {});
}

function isRuntimeEnvFileKey(key) {
  if (RUNTIME_DIRECT_ENV_KEYS.has(key)) return true;
  const currentPrefix = 'RKAPI_IMAGE_';
  const legacyPrefix = 'FLYREQ_';
  if (key.startsWith(currentPrefix)) return RUNTIME_ENV_VALUE_KEYS.has(key.slice(currentPrefix.length));
  if (key.startsWith(legacyPrefix)) return RUNTIME_ENV_VALUE_KEYS.has(key.slice(legacyPrefix.length));
  return false;
}

function getRuntimeOnlyEnv(fileEnv) {
  const values = {};
  for (const key of RUNTIME_DIRECT_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(fileEnv, key)) values[key] = fileEnv[key];
  }
  for (const key of RUNTIME_ENV_VALUE_KEYS) {
    const currentKey = `RKAPI_IMAGE_${key}`;
    const legacyKey = `FLYREQ_${key}`;
    const hasCurrentKey = Object.prototype.hasOwnProperty.call(fileEnv, currentKey);
    const hasLegacyKey = Object.prototype.hasOwnProperty.call(fileEnv, legacyKey);
    if (!hasCurrentKey && !hasLegacyKey && getRuntimeEnvValue(fileEnv, key) === undefined) continue;
    if (hasCurrentKey || hasLegacyKey) {
      values[currentKey] = hasCurrentKey ? fileEnv[currentKey] : '';
      values[legacyKey] = hasLegacyKey ? fileEnv[legacyKey] : '';
    }
  }
  return values;
}

// .env 运行期读取加 1 秒 TTL 缓存：原本每次调用都同步 readFileSync，而
// getQueueStats / 建任务 / 队列广播 / WS 订阅 / 出图前都走它（单次 getQueueStats
// 触发 3 次读盘），在事件循环上造成不必要的同步 IO。1 秒对"改 .env 实时生效"
// 而言对人类无感，符合 README 承诺。
let _runtimeEnvCache = { values: null, expiresAt: 0 };

function getRuntimeEnv() {
  const now = Date.now();
  if (!_runtimeEnvCache.values || now >= _runtimeEnvCache.expiresAt) {
    const fileEnv = parseEnvFiles();
    _runtimeEnvCache = {
      values: { ...fileEnv, ...process.env, ...getRuntimeOnlyEnv(fileEnv) },
      expiresAt: now + 1000,
    };
  }
  return _runtimeEnvCache.values;
}

function getRuntimeEnvValue(env, key) {
  const currentValue = env[`RKAPI_IMAGE_${key}`];
  if (currentValue !== undefined && String(currentValue).trim() !== '') return currentValue;
  return env[`FLYREQ_${key}`];
}

function loadEnvFile() {
  const values = parseEnvFiles();
  for (const [key, value] of Object.entries(values)) {
    if (isRuntimeEnvFileKey(key)) continue;
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const next = process.env.NODE_ENV !== 'production' ? require('next') : null;

/**
 * 生成带时区标识的 ISO 8601 日志时间戳，便于按时间检索线上日志。
 * @returns 当前 UTC 时间的 ISO 8601 字符串。
 */
function getLogTimestamp() {
  return new Date().toISOString();
}

/**
 * 为后端标准日志统一添加时间戳，同时保留原始 console 的对象和错误输出格式。
 * @returns 无返回值。
 */
function installTimestampedConsole() {
  for (const method of ['log', 'info', 'warn', 'error']) {
    const write = console[method].bind(console);
    console[method] = (...args) => write(`[${getLogTimestamp()}]`, ...args);
  }
}

installTimestampedConsole();

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function normalizeProtocolBaseUrl(protocol, url) {
  return normalizeBaseUrl(url);
}

function getProtocolApiPrefix(protocol) {
  return protocol === 'google' ? '/v1beta' : '/v1';
}

function getProtocolVersionSuffix(protocol, url) {
  const normalized = normalizeBaseUrl(url);
  if (!normalized) return '';
  const apiPrefix = getProtocolApiPrefix(protocol);
  return normalized.toLowerCase().endsWith(apiPrefix) ? apiPrefix : '';
}

function stripProtocolVersionSuffix(protocol, url) {
  const normalized = normalizeBaseUrl(url);
  const suffix = getProtocolVersionSuffix(protocol, normalized);
  return suffix ? normalized.slice(0, -suffix.length) : normalized;
}

function appendProtocolApiPath(protocol, baseUrl, apiPath) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const apiPrefix = getProtocolApiPrefix(protocol);
  if (normalizedBaseUrl.toLowerCase().endsWith(apiPrefix) && normalizedPath.toLowerCase().startsWith(`${apiPrefix}/`)) {
    return `${normalizedBaseUrl}${normalizedPath.slice(apiPrefix.length)}`;
  }
  return `${normalizedBaseUrl}${normalizedPath}`;
}

function resolveFixedRkapiGatewayBaseUrl(_protocol, _baseUrl) {
  return normalizeBaseUrl(RKAPI_GATEWAY_BASE_URL);
}

function resolveFlyreqApiBaseUrl() {
  return resolveFixedRkapiGatewayBaseUrl();
}

/**
 * 解析用于上游请求的稳定服务标识，过滤非法字符以避免请求头注入。
 * @param env 运行时环境变量，用于读取可配置的服务标识。
 * @returns 可安全写入 User-Agent 请求头的服务标识。
 */
function resolveOutboundUserAgent(env = getRuntimeEnv()) {
  const configured = sanitizeOutboundHeaderValue(String(getRuntimeEnvValue(env, 'OUTBOUND_USER_AGENT') || ''))
    .trim()
    .slice(0, 256);
  return configured || DEFAULT_OUTBOUND_USER_AGENT;
}

/**
 * 将 HTTP 请求头中不允许出现的控制字符替换为空格，避免 Headers 构造失败。
 * @param value 待清理的请求头值。
 * @returns 不含 HTTP 控制字符的请求头值。
 */
function sanitizeOutboundHeaderValue(value) {
  let sanitized = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    sanitized += code <= 31 || code === 127 ? ' ' : character;
  }
  return sanitized;
}

/**
 * 合并上游请求头并确保携带稳定的服务标识，不覆盖调用方显式提供的 User-Agent。
 * @param headers 调用方提供的请求头。
 * @param env 运行时环境变量，用于读取服务标识配置。
 * @returns 可直接传给 fetch 的完整请求头对象。
 */
function createOutboundHeaders(headers, env = getRuntimeEnv()) {
  const mergedHeaders = new Headers(headers || {});
  if (!mergedHeaders.has('user-agent')) {
    mergedHeaders.set('user-agent', resolveOutboundUserAgent(env));
  }
  return mergedHeaders;
}

function parseBaseUrlRewriteMap(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map(item => Array.isArray(item)
          ? { from: item[0], to: item[1] }
          : { from: item?.from ?? item?.source, to: item?.to ?? item?.target })
        .filter(item => item.from && item.to);
    }
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed).map(([from, to]) => ({ from, to }));
    }
  } catch {
    // Fall through to the compact text format.
  }

  return raw
    .split(/[,\n;]/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const separator = part.includes('=>') ? '=>' : '=';
      const index = part.indexOf(separator);
      if (index <= 0) return null;
      return {
        from: part.slice(0, index).trim(),
        to: part.slice(index + separator.length).trim(),
      };
    })
    .filter(Boolean);
}

function resolveOutboundBaseUrl(protocol, baseUrl, env = getRuntimeEnv()) {
  return resolveOutboundBaseUrlDetails(protocol, baseUrl, env).baseUrl;
}

function resolveOutboundBaseUrlDetails(protocol, baseUrl, env = getRuntimeEnv()) {
  const normalizedBaseUrl = normalizeProtocolBaseUrl(protocol, baseUrl);
  const matchBaseUrl = stripProtocolVersionSuffix(protocol, normalizedBaseUrl);
  const sourceVersionSuffix = getProtocolVersionSuffix(protocol, normalizedBaseUrl);
  const rewrites = parseBaseUrlRewriteMap(getRuntimeEnvValue(env, 'BASE_URL_REWRITE_MAP'));

  for (const rewrite of rewrites) {
    const from = stripProtocolVersionSuffix(protocol, rewrite.from);
    if (!from || from.toLowerCase() !== matchBaseUrl.toLowerCase()) continue;
    const to = normalizeProtocolBaseUrl(protocol, rewrite.to);
    if (to) {
      const targetVersionSuffix = getProtocolVersionSuffix(protocol, to);
      const rewrittenBaseUrl = sourceVersionSuffix && !targetVersionSuffix
        ? `${to}${sourceVersionSuffix}`
        : to;
      return { baseUrl: rewrittenBaseUrl, originalBaseUrl: normalizedBaseUrl, rewritten: true, rewriteCount: rewrites.length };
    }
  }

  return { baseUrl: normalizedBaseUrl, originalBaseUrl: normalizedBaseUrl, rewritten: false, rewriteCount: rewrites.length };
}

/**
 * 为即将发送到上游的请求解析 Base URL，并记录完整的映射诊断信息。
 * @param requestType 上游请求类别，用于在日志中区分图片生成、文本代理或模型列表请求。
 * @param protocol 上游 API 协议标识。
 * @param baseUrl 用户配置的原始 Base URL。
 * @param env 运行时环境变量，用于读取 Base URL 映射表。
 * @returns 包含实际出站 Base URL、原始 Base URL 与映射命中状态的解析结果。
 */
function resolveAndLogOutboundBaseUrl(requestType, protocol, baseUrl, env = getRuntimeEnv()) {
  const details = resolveOutboundBaseUrlDetails(protocol, baseUrl, env);
  const status = details.rewritten ? '已应用' : details.rewriteCount > 0 ? '未命中' : '未配置';
  console.info(`[base-url-rewrite] 状态=${status} 请求=${requestType} 协议=${protocol} 原始Base URL=${details.originalBaseUrl} 最终Base URL=${details.baseUrl} 映射规则数=${details.rewriteCount}`);
  return details;
}

/**
 * 在服务启动时输出实际加载的 Base URL 映射，排除部署环境未挂载配置文件的可能。
 * @returns 无返回值；日志仅包含映射地址，不包含 API Key 等敏感信息。
 */
function logBaseUrlRewriteConfiguration() {
  const rewrites = parseBaseUrlRewriteMap(getRuntimeEnvValue(getRuntimeEnv(), 'BASE_URL_REWRITE_MAP'));
  const mappings = rewrites
    .map(rewrite => `${normalizeBaseUrl(rewrite.from)}=>${normalizeBaseUrl(rewrite.to)}`)
    .join(' | ');
  console.info(`[base-url-rewrite] 启动配置 规则数=${rewrites.length}${mappings ? ` 规则=${mappings}` : ''}`);
}

function getUrlOrigin(value) {
  try {
    return new URL(normalizeBaseUrl(value)).origin.toLowerCase();
  } catch {
    return '';
  }
}

function getSafeUrlLabel(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value || '').slice(0, 120);
  }
}

function shouldAuthorizeRemoteImageDownload(imageUrl, request, env = getRuntimeEnv()) {
  const imageOrigin = getUrlOrigin(imageUrl);
  if (!imageOrigin) return false;

  const fixedBaseUrl = resolveFixedRkapiGatewayBaseUrl(request?.protocol, request?.baseUrl);
  const outboundBaseUrl = resolveOutboundBaseUrl(request?.protocol, fixedBaseUrl, env);

  const allowedOrigins = new Set([
    getUrlOrigin(fixedBaseUrl),
    getUrlOrigin(outboundBaseUrl),
  ].filter(Boolean));

  return allowedOrigins.has(imageOrigin);
}

function resolveImageModelKeyGuide(env = getRuntimeEnv()) {
  const title = String(getRuntimeEnvValue(env, 'IMAGE_MODEL_KEY_GUIDE_TITLE') || '').trim();
  const description = String(getRuntimeEnvValue(env, 'IMAGE_MODEL_KEY_GUIDE_DESCRIPTION') || '').trim();
  const ctaLabel = String(getRuntimeEnvValue(env, 'IMAGE_MODEL_KEY_GUIDE_CTA_LABEL') || '').trim();
  const url = String(getRuntimeEnvValue(env, 'IMAGE_MODEL_KEY_GUIDE_URL') || '').trim();
  return {
    title: title || DEFAULT_IMAGE_MODEL_KEY_GUIDE.title,
    description: description || DEFAULT_IMAGE_MODEL_KEY_GUIDE.description,
    ctaLabel: ctaLabel || DEFAULT_IMAGE_MODEL_KEY_GUIDE.ctaLabel,
    url: url || DEFAULT_IMAGE_MODEL_KEY_GUIDE.url,
  };
}

function hashPromptGalleryPassword(password) {
  return createHash('sha256')
    .update(`${PROMPT_GALLERY_PASSWORD_SALT}${String(password || '')}`)
    .digest('hex');
}

const PORT = Number(process.env.PORT || 3001);
const HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
const DB_PATH = getRuntimeEnvValue(getRuntimeEnv(), 'TASK_DB') || path.join(__dirname, 'flyreq-tasks.sqlite');
const TASK_TTL_MS = 12 * 60 * 60 * 1000;
const ACK_GRACE_MS = 120 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const TASK_CANCELLED_ERROR = '用户已取消任务';
const XAI_IMAGINE_MAX_REQUESTS_PER_SECOND = 5;
const XAI_IMAGINE_REQUEST_INTERVAL_MS = 1000 / XAI_IMAGINE_MAX_REQUESTS_PER_SECOND;
const XAI_IMAGINE_MAX_RETRIES = 1;
const XAI_IMAGINE_DEFAULT_RETRY_DELAY_MS = 1000;
// 开源版：不再硬编码模型列表，由前端通过 protocol 字段指定协议类型
const VALID_PROTOCOLS = new Set(['google', 'openai']);
const VALID_OUTPUT_SIZES = new Set(['auto', '512', '1K', '2K', '4K']);
const VALID_ASPECT_RATIOS = new Set([
  'auto', '1:1', '1:2', '1:4', '1:8', '2:1', '2:3', '3:2', '3:4',
  '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '9:19.5', '9:20',
  '16:9', '19.5:9', '20:9', '21:9',
]);
const VALID_REFERENCE_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const MAX_REFERENCE_IMAGES = 16;
const GPT_IMAGE_QUALITIES = new Set(['auto', 'high', 'medium', 'low']);
const GPT_IMAGE_STYLES = new Set(['auto', 'vivid', 'natural']);
const GPT_IMAGE_BACKGROUNDS = new Set(['auto', 'transparent', 'opaque']);
const GPT_IMAGE_OUTPUT_FORMATS = new Set(['png', 'jpeg', 'webp']);
const IMAGE_API_FLAVORS = new Set(['xai-imagine']);
const XAI_IMAGINE_OUTPUT_SIZES = new Set(['1K', '2K']);
const XAI_IMAGINE_ASPECT_RATIOS = new Set([
  'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
  '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20',
]);
const DEFAULT_GPT_IMAGE_ADVANCED_PARAMS = {
  quality: 'auto',
  style: 'auto',
  background: 'auto',
  outputFormat: 'png',
};
const PROMPT_GALLERY_PASSWORD_SALT = 'flyreq-pg-2026';
const PROMPT_GALLERY_ACCESS_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const PROMPT_GALLERY_ACCESS_COOKIE = 'rkapi_prompt_gallery_token';
const CUSTOM_IMAGE_SIZE_LIMITS = {
  multiple: 16,
  maxAspectRatio: 3,
  minPixels: 655360,
  maxPixels: 8294400,
};
const IS_DEV = process.env.NODE_ENV !== 'production';
const STATIC_DIR = path.join(__dirname, '..', 'frontend', 'out');
const IMAGE_DIR = getRuntimeEnvValue(getRuntimeEnv(), 'IMAGE_DIR') || path.join(__dirname, 'flyreq-images');
const taskRefImages = new Map();

const app = IS_DEV ? next({ dev: IS_DEV, hostname: HOSTNAME, port: PORT, dir: path.join(__dirname, '..', 'frontend') }) : null;
const handle = app ? app.getRequestHandler() : null;
const db = new Database(DB_PATH);
const apiKeys = new Map();
const taskSources = new Map(); // taskId -> { ip, apiKeyHash }
const taskAbortControllers = new Map();
const cancelledTaskIds = new Set();
const rateLimitBuckets = new Map(); // key -> { windowStart: number, count: number }
const promptGalleryAccessTokens = new Map(); // token -> { expiresAt, passwordHash }
const pendingCountByIp = new Map(); // ip -> count
const pendingCountByApiKeyHash = new Map(); // apiKeyHash -> count
const xaiImagineNextRequestAtByApiKeyHash = new Map(); // apiKeyHash -> next request start timestamp
const queue = [];
let activeCount = 0;

// ===== WebSocket subscription state =====
const taskSubscriptions = new Map(); // WebSocket -> Map<taskId, readToken>
const queueSubscribers = new Set(); // Set<WebSocket>
const wsAlive = new WeakMap(); // WebSocket -> { lastPong: number, missed: number }
const WS_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const WS_PONG_GRACE_MS = 10 * 1000;
// 单条 subscribeTasks 消息最多处理的 taskId 数，以及单连接订阅总量上限，
// 防止一条消息被放大成大量 DB 查询（DoS 面）。
const WS_MAX_TASK_IDS_PER_MESSAGE = 200;
const WS_MAX_SUBSCRIPTIONS_PER_SOCKET = 500;
let queueBroadcastTimer = null;
let queueBroadcastPending = false;

function getMaxServerConcurrency() {
  const configured = Number(getRuntimeEnvValue(getRuntimeEnv(), 'TASK_CONCURRENCY') || GLOBAL_TASK_CONCURRENCY);
  const safeConfigured = Number.isFinite(configured) ? configured : GLOBAL_TASK_CONCURRENCY;
  return Math.max(1, Math.min(GLOBAL_TASK_CONCURRENCY, safeConfigured));
}

function parseIntegerEnv(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function getLimitConfig() {
  const env = getRuntimeEnv();
  return {
    maxQueueSize: parseIntegerEnv(getRuntimeEnvValue(env, 'MAX_QUEUE_SIZE'), DEFAULT_LIMIT_CONFIG.maxQueueSize, { min: 0, max: 100000 }),
    rateLimitWindowMs: parseIntegerEnv(getRuntimeEnvValue(env, 'RATE_LIMIT_WINDOW_MS'), DEFAULT_LIMIT_CONFIG.rateLimitWindowMs, { min: 1000, max: 24 * 60 * 60 * 1000 }),
    maxRequestsPerIp: parseIntegerEnv(getRuntimeEnvValue(env, 'RATE_LIMIT_MAX_REQUESTS_PER_IP'), DEFAULT_LIMIT_CONFIG.maxRequestsPerIp, { min: 0, max: 100000 }),
    maxRequestsPerApiKey: parseIntegerEnv(getRuntimeEnvValue(env, 'RATE_LIMIT_MAX_REQUESTS_PER_API_KEY'), DEFAULT_LIMIT_CONFIG.maxRequestsPerApiKey, { min: 0, max: 100000 }),
    maxPendingTasksPerIp: parseIntegerEnv(getRuntimeEnvValue(env, 'MAX_PENDING_TASKS_PER_IP'), DEFAULT_LIMIT_CONFIG.maxPendingTasksPerIp, { min: 0, max: 100000 }),
    maxPendingTasksPerApiKey: parseIntegerEnv(getRuntimeEnvValue(env, 'MAX_PENDING_TASKS_PER_API_KEY'), DEFAULT_LIMIT_CONFIG.maxPendingTasksPerApiKey, { min: 0, max: 100000 }),
    retryAfterSeconds: parseIntegerEnv(getRuntimeEnvValue(env, 'RATE_LIMIT_RETRY_AFTER_SECONDS'), DEFAULT_LIMIT_CONFIG.retryAfterSeconds, { min: 1, max: 24 * 60 * 60 }),
  };
}

function createHttpError(statusCode, code, message, retryAfterSeconds) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.retryAfter = retryAfterSeconds;
  return error;
}

function isHttpError(error) {
  return error && typeof error.statusCode === 'number' && typeof error.code === 'string';
}

function normalizeIp(value) {
  return String(value || '').trim().replace(/^::ffff:/, '');
}

function getClientIp(req, env = getRuntimeEnv()) {
  const remoteAddress = normalizeIp(req?.socket?.remoteAddress || '');
  const trustedProxyIps = String(getRuntimeEnvValue(env, 'TRUSTED_PROXY_IPS') || '')
    .split(/[,\s]+/)
    .map(normalizeIp)
    .filter(Boolean);
  const isTrustedProxy = Boolean(remoteAddress) && (trustedProxyIps.includes('*') || trustedProxyIps.includes(remoteAddress));
  if (!isTrustedProxy) return remoteAddress || 'unknown';

  const forwardedFor = req?.headers?.['x-forwarded-for'];
  const firstForwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const forwardedIp = normalizeIp(String(firstForwarded || '').split(',')[0]);
  return forwardedIp || remoteAddress || 'unknown';
}

function hashApiKey(apiKey) {
  return createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 24);
}

function generateTaskReadToken() {
  return randomBytes(24).toString('base64url');
}

function hashTaskReadToken(readToken) {
  const token = String(readToken || '').trim();
  if (!token) return '';
  return createHash('sha256').update(token).digest('hex');
}

function getRequestReadToken(req) {
  const headerValue = req?.headers?.['x-rkapi-task-token'] || req?.headers?.['x-flyreq-task-token'];
  if (Array.isArray(headerValue)) return headerValue[0] || '';
  return String(headerValue || '');
}

function verifyTaskReadToken(taskId, readToken) {
  const row = db.prepare('SELECT read_token_hash FROM tasks WHERE id = ?').get(taskId);
  if (!row || !row.read_token_hash) return true;

  const actualHash = hashTaskReadToken(readToken);
  if (!actualHash) return false;

  const expected = Buffer.from(String(row.read_token_hash), 'hex');
  const actual = Buffer.from(actualHash, 'hex');
  return expected.length > 0 && expected.length === actual.length && timingSafeEqual(actual, expected);
}

function sendInvalidTaskReadToken(res) {
  sendJson(res, 403, { error: '任务读取凭证无效', code: 'INVALID_TASK_TOKEN' });
}

function resolvePromptGalleryMode(env = getRuntimeEnv()) {
  const rawMode = String(env.PROMPT_GALLERY_MODE || '2').trim();
  return ['1', '2', '3'].includes(rawMode) ? rawMode : '2';
}

function safeEqualHex(left, right) {
  const leftValue = String(left || '');
  const rightValue = String(right || '');
  if (!leftValue || leftValue.length !== rightValue.length) return false;
  const leftBuffer = Buffer.from(leftValue, 'hex');
  const rightBuffer = Buffer.from(rightValue, 'hex');
  return leftBuffer.length > 0 && leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyPromptGalleryPassword(password, expected) {
  return safeEqualHex(hashPromptGalleryPassword(password), hashPromptGalleryPassword(expected));
}

function cleanupPromptGalleryAccessTokens(now = Date.now()) {
  for (const [token, entry] of promptGalleryAccessTokens) {
    if (!entry || entry.expiresAt <= now) promptGalleryAccessTokens.delete(token);
  }
}

function issuePromptGalleryAccessToken(expected) {
  cleanupPromptGalleryAccessTokens();
  const token = randomBytes(24).toString('base64url');
  promptGalleryAccessTokens.set(token, {
    expiresAt: Date.now() + PROMPT_GALLERY_ACCESS_TOKEN_TTL_MS,
    passwordHash: hashPromptGalleryPassword(expected),
  });
  return token;
}

function getCookieValue(req, name) {
  const rawCookie = req?.headers?.cookie;
  const cookies = Array.isArray(rawCookie) ? rawCookie.join(';') : String(rawCookie || '');
  for (const part of cookies.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = part.slice(0, separatorIndex).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separatorIndex + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function buildPromptGalleryAccessCookie(token) {
  const maxAge = Math.floor(PROMPT_GALLERY_ACCESS_TOKEN_TTL_MS / 1000);
  return `${PROMPT_GALLERY_ACCESS_COOKIE}=${encodeURIComponent(token)}; Path=/api/flyreq; Max-Age=${maxAge}; SameSite=Strict; HttpOnly`;
}

function getPromptGalleryAccessToken(req) {
  const headerValue = req?.headers?.['x-rkapi-prompt-gallery-token'] || req?.headers?.['x-flyreq-prompt-gallery-token'];
  if (Array.isArray(headerValue)) return headerValue[0] || '';
  return String(headerValue || '').trim() || getCookieValue(req, PROMPT_GALLERY_ACCESS_COOKIE);
}

function authorizePromptGalleryDataRequest(req, env = getRuntimeEnv()) {
  const mode = resolvePromptGalleryMode(env);
  if (mode === '1') return true;
  if (mode === '3') return false;

  const expected = String(env.PROMPT_GALLERY_PASSWORD || '').trim();
  if (!expected) return true;

  cleanupPromptGalleryAccessTokens();
  const token = getPromptGalleryAccessToken(req);
  if (!token) return false;
  const entry = promptGalleryAccessTokens.get(token);
  if (!entry || entry.expiresAt <= Date.now()) {
    promptGalleryAccessTokens.delete(token);
    return false;
  }
  return safeEqualHex(entry.passwordHash, hashPromptGalleryPassword(expected));
}

function sendPromptGalleryAccessDenied(res, env = getRuntimeEnv()) {
  const mode = resolvePromptGalleryMode(env);
  sendJson(res, 403, {
    error: mode === '3' ? '提示词广场已关闭' : '提示词广场未授权',
    code: mode === '3' ? 'PROMPT_GALLERY_DISABLED' : 'PROMPT_GALLERY_LOCKED',
  });
}

/**
 * 解析图片模板到实际模型 ID 的运行时环境变量映射。
 * @param {Record<string, string>} env 当前运行时环境变量。
 * @returns {Record<string, string>} 经白名单过滤后的模板模型 ID 映射。
 */
function resolveImagePresetModelIds(env = getRuntimeEnv()) {
  const raw = String(getRuntimeEnvValue(env, 'IMAGE_PRESET_MODEL_IDS') || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result = {};
    for (const [presetId, value] of Object.entries(parsed)) {
      if (BUILTIN_IMAGE_PRESET_IDS.has(presetId) && typeof value === 'string' && value.trim()) result[presetId] = value.trim();
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * 解析布尔型环境变量，仅接受常用的真值和假值字符串。
 * @param value 环境变量原始值。
 * @param fallback 变量缺失或无效时采用的默认值。
 * @returns 归一化后的布尔值。
 */
function parseBooleanEnv(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

/**
 * 读取部署级首次图片模型配置，不包含 API Key，避免将密钥下发给浏览器。
 * @param env 合并后的运行时环境变量对象。
 * @returns 可安全传递到前端并用于首次初始化的图片模型配置。
 */
function resolveDefaultImageModelConfig(env = getRuntimeEnv()) {
  const presetCandidate = String(getRuntimeEnvValue(env, 'DEFAULT_IMAGE_MODEL_PRESET') || '').trim();
  const builtinPreset = BUILTIN_IMAGE_PRESET_IDS.has(presetCandidate)
    ? presetCandidate
    : DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.builtinPreset;
  const protocolCandidate = String(getRuntimeEnvValue(env, 'DEFAULT_IMAGE_MODEL_PROTOCOL') || '').trim();
  const protocol = protocolCandidate === 'google' || protocolCandidate === 'openai'
    ? protocolCandidate
    : DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.protocol;
  const configuredModelId = String(getRuntimeEnvValue(env, 'DEFAULT_IMAGE_MODEL_MODEL_ID') || '').trim().slice(0, 200);
  const supportsAdvancedParams = protocol === 'openai' && builtinPreset === 'gpt-image-2'
    ? parseBooleanEnv(getRuntimeEnvValue(env, 'DEFAULT_IMAGE_MODEL_SUPPORTS_ADVANCED_PARAMS'), DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.supportsAdvancedParams)
    : false;
  const streamImages = protocol === 'openai' && builtinPreset === 'gpt-image-2'
    ? parseBooleanEnv(getRuntimeEnvValue(env, 'DEFAULT_IMAGE_MODEL_STREAM_IMAGES'), DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.streamImages)
    : false;
  return {
    id: DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.id,
    protocol,
    name: DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.name,
    modelId: configuredModelId || DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.modelId,
    usesPresetModelId: false,
    baseUrl: DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.baseUrl,
    builtinPreset,
    maxRefImages: parseIntegerEnv(getRuntimeEnvValue(env, 'DEFAULT_IMAGE_MODEL_MAX_REF_IMAGES'), DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.maxRefImages, { min: 1, max: 16 }),
    maxOutputSize: DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.maxOutputSize,
    supportsAdvancedParams,
    supportsTemperature: protocol === 'google'
      ? parseBooleanEnv(getRuntimeEnvValue(env, 'DEFAULT_IMAGE_MODEL_SUPPORTS_TEMPERATURE'), false)
      : false,
    streamImages,
  };
}

function getAbortSignalReason(signal) {
  return signal?.reason || new Error('请求已取消');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw getAbortSignalReason(signal);
  }
}

function delay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let timeout = null;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(getAbortSignalReason(signal));
    };
    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', abort, { once: true });
  });
}

async function waitForXaiImagineRequestSlot(apiKey, signal) {
  const apiKeyHash = hashApiKey(apiKey);
  const now = Date.now();
  const nextRequestAt = xaiImagineNextRequestAtByApiKeyHash.get(apiKeyHash) || now;
  const scheduledAt = Math.max(now, nextRequestAt);
  xaiImagineNextRequestAtByApiKeyHash.set(apiKeyHash, scheduledAt + XAI_IMAGINE_REQUEST_INTERVAL_MS);

  if (scheduledAt > now) {
    await delay(scheduledAt - now, signal);
  }
}

function getRetryAfterDelayMs(response) {
  const retryAfter = response.headers.get('retry-after');
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);

  const retryAt = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - Date.now())
    : XAI_IMAGINE_DEFAULT_RETRY_DELAY_MS;
}

function cleanupTaskRuntimeState(taskId) {
  const source = taskSources.get(taskId);
  const pendingCost = normalizeRateLimitCost(source?.pendingCost || 1);
  if (source) {
    // 递减 IP 计数
    if (source.ip) {
      const ipCount = pendingCountByIp.get(source.ip) || 0;
      const nextCount = ipCount - pendingCost;
      if (nextCount <= 0) {
        pendingCountByIp.delete(source.ip);
      } else {
        pendingCountByIp.set(source.ip, nextCount);
      }
    }
    // 递减 apiKeyHash 计数
    if (source.apiKeyHash) {
      const hashCount = pendingCountByApiKeyHash.get(source.apiKeyHash) || 0;
      const nextCount = hashCount - pendingCost;
      if (nextCount <= 0) {
        pendingCountByApiKeyHash.delete(source.apiKeyHash);
      } else {
        pendingCountByApiKeyHash.set(source.apiKeyHash, nextCount);
      }
    }
  }
  apiKeys.delete(taskId);
  taskRefImages.delete(taskId);
  taskSources.delete(taskId);
}

function getPendingCountForSource(fieldName, value) {
  if (!value) return 0;
  // O(1) 查找：使用独立计数器代替遍历 taskSources
  if (fieldName === 'ip') return pendingCountByIp.get(value) || 0;
  if (fieldName === 'apiKeyHash') return pendingCountByApiKeyHash.get(value) || 0;
  // fallback：未知字段仍用遍历（不应发生）
  let count = 0;
  for (const source of taskSources.values()) {
    if (source?.[fieldName] === value) count++;
  }
  return count;
}

function normalizeRateLimitCost(requestedTasks) {
  return Math.max(1, Math.min(MAX_PARALLEL_COUNT, Math.trunc(Number(requestedTasks)) || 1));
}

function checkRateLimit(bucketKey, maxRequests, windowMs, requestedTasks = 1) {
  const cost = normalizeRateLimitCost(requestedTasks);
  if (maxRequests <= 0) {
    return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }
  if (cost > maxRequests) {
    return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }
  const now = Date.now();
  const existing = rateLimitBuckets.get(bucketKey);
  if (!existing || now - existing.windowStart >= windowMs) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (existing.count + cost > maxRequests) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - existing.windowStart)) / 1000)) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function applyRateLimit(bucketKey, _maxRequests, windowMs, requestedTasks = 1) {
  const cost = normalizeRateLimitCost(requestedTasks);
  const now = Date.now();
  const existing = rateLimitBuckets.get(bucketKey);
  if (!existing || now - existing.windowStart >= windowMs) {
    rateLimitBuckets.set(bucketKey, { windowStart: now, count: cost });
    return;
  }
  existing.count += cost;
}

function cleanupRateLimitBuckets() {
  const now = Date.now();
  const maxWindowMs = getLimitConfig().rateLimitWindowMs;
  for (const [key, bucket] of rateLimitBuckets) {
    if (!bucket || now - bucket.windowStart > maxWindowMs * 2) {
      rateLimitBuckets.delete(key);
    }
  }
  for (const [apiKeyHash, nextRequestAt] of xaiImagineNextRequestAtByApiKeyHash) {
    if (!Number.isFinite(nextRequestAt) || now - nextRequestAt > maxWindowMs * 2) {
      xaiImagineNextRequestAtByApiKeyHash.delete(apiKeyHash);
    }
  }
}

function enforceRateLimit(req, body, config, requestedTasks = 1) {
  const ip = getClientIp(req);
  const apiKeyHash = hashApiKey(body.apiKey);
  const taskCost = normalizeRateLimitCost(requestedTasks);
  const ipLimit = checkRateLimit(`ip:${ip}`, config.maxRequestsPerIp, config.rateLimitWindowMs, taskCost);
  if (!ipLimit.allowed) {
    throw createHttpError(429, 'RATE_LIMITED', LIMIT_ERROR_MESSAGES.rateLimited, Math.max(config.retryAfterSeconds, ipLimit.retryAfterSeconds));
  }
  const apiKeyLimit = checkRateLimit(`api:${apiKeyHash}`, config.maxRequestsPerApiKey, config.rateLimitWindowMs, taskCost);
  if (!apiKeyLimit.allowed) {
    throw createHttpError(429, 'RATE_LIMITED', LIMIT_ERROR_MESSAGES.rateLimited, Math.max(config.retryAfterSeconds, apiKeyLimit.retryAfterSeconds));
  }
  applyRateLimit(`ip:${ip}`, config.maxRequestsPerIp, config.rateLimitWindowMs, taskCost);
  applyRateLimit(`api:${apiKeyHash}`, config.maxRequestsPerApiKey, config.rateLimitWindowMs, taskCost);
  return { ip, apiKeyHash };
}

function normalizeRateLimitScope(scope) {
  const normalized = String(scope || '').trim().replace(/[^a-zA-Z0-9:_-]/g, '-');
  return normalized || 'api';
}

function enforceScopedApiRateLimit(req, { scope, apiKey, includeApiKey = true, requestedRequests = 1 } = {}) {
  const config = getLimitConfig();
  const rateLimitScope = normalizeRateLimitScope(scope);
  const ip = getClientIp(req);
  const requestCost = normalizeRateLimitCost(requestedRequests);
  const ipBucket = `scoped:${rateLimitScope}:ip:${ip}`;
  const ipLimit = checkRateLimit(ipBucket, config.maxRequestsPerIp, config.rateLimitWindowMs, requestCost);
  if (!ipLimit.allowed) {
    throw createHttpError(429, 'RATE_LIMITED', LIMIT_ERROR_MESSAGES.rateLimited, Math.max(config.retryAfterSeconds, ipLimit.retryAfterSeconds));
  }

  const apiKeyValue = String(apiKey || '');
  const apiKeyHash = includeApiKey && apiKeyValue ? hashApiKey(apiKeyValue) : '';
  const apiKeyBucket = apiKeyHash ? `scoped:${rateLimitScope}:api:${apiKeyHash}` : '';
  if (apiKeyBucket) {
    const apiKeyLimit = checkRateLimit(apiKeyBucket, config.maxRequestsPerApiKey, config.rateLimitWindowMs, requestCost);
    if (!apiKeyLimit.allowed) {
      throw createHttpError(429, 'RATE_LIMITED', LIMIT_ERROR_MESSAGES.rateLimited, Math.max(config.retryAfterSeconds, apiKeyLimit.retryAfterSeconds));
    }
  }

  applyRateLimit(ipBucket, config.maxRequestsPerIp, config.rateLimitWindowMs, requestCost);
  if (apiKeyBucket) applyRateLimit(apiKeyBucket, config.maxRequestsPerApiKey, config.rateLimitWindowMs, requestCost);
  return { ip, apiKeyHash };
}

/**
 * 校验队列和来源维度是否有足够容量接收新任务。
 * @param source 当前请求的 IP 与 API Key 哈希来源；为空时只校验全局队列容量。
 * @param config 运行时队列与限额配置。
 * @param requestedSlots 本次请求占用的图片生成槽位数量。
 * @param requestedTasks 本次请求将创建的独立任务数量。
 * @returns 无返回值；容量不足时抛出带 HTTP 状态码的异常。
 */
function enforceQueueCapacity(source, config, requestedSlots = 1, requestedTasks = 1) {
  const stats = getQueueStats();
  const slotsToReserve = Math.max(1, Math.min(MAX_PARALLEL_COUNT, Math.trunc(Number(requestedSlots)) || 1));
  const tasksToReserve = Math.max(1, Math.min(MAX_PARALLEL_COUNT, Math.trunc(Number(requestedTasks)) || 1));
  if (stats.pendingCount >= config.maxQueueSize) {
    throw createHttpError(503, 'QUEUE_FULL', LIMIT_ERROR_MESSAGES.queueFull, config.retryAfterSeconds);
  }
  if (stats.pendingCount + tasksToReserve > config.maxQueueSize) {
    throw createHttpError(503, 'QUEUE_FULL', LIMIT_ERROR_MESSAGES.queueFull, config.retryAfterSeconds);
  }
  if (stats.pendingSlots + slotsToReserve > config.maxQueueSize) {
    throw createHttpError(503, 'QUEUE_FULL', LIMIT_ERROR_MESSAGES.queueFull, config.retryAfterSeconds);
  }
  if (!source) return;
  if (getPendingCountForSource('ip', source.ip) + tasksToReserve > config.maxPendingTasksPerIp) {
    throw createHttpError(429, 'TOO_MANY_PENDING_TASKS', LIMIT_ERROR_MESSAGES.tooManyPending, config.retryAfterSeconds);
  }
  if (getPendingCountForSource('apiKeyHash', source.apiKeyHash) + tasksToReserve > config.maxPendingTasksPerApiKey) {
    throw createHttpError(429, 'TOO_MANY_PENDING_TASKS', LIMIT_ERROR_MESSAGES.tooManyPending, config.retryAfterSeconds);
  }
}

function isRejectNewTasksEnabled() {
  const env = getRuntimeEnv();
  const rejectSwitch = String(getRuntimeEnvValue(env, 'REJECT_NEW_TASKS') || '').trim().toLowerCase();
  const acceptSwitch = String(getRuntimeEnvValue(env, 'ACCEPT_NEW_TASKS') || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(rejectSwitch) || acceptSwitch === 'false' || acceptSwitch === '0';
}

function getQueueStats() {
  const config = getLimitConfig();
  const configuredConcurrency = getMaxServerConcurrency();
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count, SUM(slot_count) AS slots
    FROM (
      SELECT
        status,
        CASE
          WHEN CAST(json_extract(request_json, '$.parallelCount') AS INTEGER) BETWEEN 1 AND ? THEN CAST(json_extract(request_json, '$.parallelCount') AS INTEGER)
          ELSE 1
        END AS slot_count
      FROM tasks
      WHERE status IN (?, ?, ?)
    )
    GROUP BY status
  `).all(MAX_PARALLEL_COUNT, TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED, TASK_STATUS.PROCESSING);
  const counts = Object.fromEntries(rows.map(row => [row.status, Number(row.count || 0)]));
  const slots = Object.fromEntries(rows.map(row => [row.status, Number(row.slots || 0)]));
  const processingCount = counts[TASK_STATUS.PROCESSING] || 0;
  const queuedCount = (counts[TASK_STATUS.QUEUED] || 0) + (counts[TASK_STATUS.LEGACY_QUEUED] || 0);
  const processingSlots = slots[TASK_STATUS.PROCESSING] || 0;
  const queuedSlots = (slots[TASK_STATUS.QUEUED] || 0) + (slots[TASK_STATUS.LEGACY_QUEUED] || 0);
  const totalActiveTasks = processingCount + queuedCount;
  const totalActiveSlots = processingSlots + queuedSlots;
  const acceptingNewTasks = !isRejectNewTasksEnabled();

  return {
    concurrencyLimit: GLOBAL_TASK_CONCURRENCY,
    configuredConcurrency,
    processingCount,
    queuedCount,
    pendingCount: totalActiveTasks,
    processingSlots,
    queuedSlots,
    pendingSlots: totalActiveSlots,
    maxQueueSize: config.maxQueueSize,
    remainingQueueSlots: Math.max(0, config.maxQueueSize - totalActiveSlots),
    displayConcurrency: Math.min(configuredConcurrency, totalActiveSlots),
    displayQueued: Math.max(0, totalActiveSlots - configuredConcurrency),
    acceptingNewTasks,
    rateLimitWindowMs: config.rateLimitWindowMs,
    rateLimitMaxRequestsPerIp: config.maxRequestsPerIp,
    rateLimitMaxRequestsPerApiKey: config.maxRequestsPerApiKey,
    retryAfterSeconds: config.retryAfterSeconds,
    serverMessage: acceptingNewTasks ? undefined : LIMIT_ERROR_MESSAGES.notAcceptingTasks,
  };
}

// ===== Image Storage Service =====

function ensureImageDir() {
  try {
    if (!fs.existsSync(IMAGE_DIR)) {
      fs.mkdirSync(IMAGE_DIR, { recursive: true });
    }
    console.log(`[image-storage] 图片存储目录: ${IMAGE_DIR}`);
  } catch (error) {
    console.error(`[image-storage] 无法创建图片存储目录: ${IMAGE_DIR}`, error);
    process.exit(1);
  }
}

function getImageExtension(mimeType) {
  if (mimeType?.includes('jpeg') || mimeType?.includes('jpg')) return 'jpg';
  if (mimeType?.includes('webp')) return 'webp';
  return 'png';
}

/**
 * 将生成图片写入磁盘，并返回可唯一定位子图的 HTTP 地址。
 * @param taskId 服务端任务标识。
 * @param itemIndex 任务内图片请求序号。
 * @param subIndex 单次上游响应中的子图序号。
 * @param imageBuffer 待保存的图片二进制数据。
 * @param mimeType 图片 MIME 类型。
 * @returns 保存路径与包含子图序号的图片访问地址。
 */
function saveImageToDisk(taskId, itemIndex, subIndex, imageBuffer, mimeType) {
  const ext = getImageExtension(mimeType);
  const fileName = `${taskId}-${itemIndex}-${subIndex}.${ext}`;
  const filePath = path.join(IMAGE_DIR, fileName);
  fs.writeFileSync(filePath, imageBuffer);
  return { filePath, httpUrl: `/api/flyreq/images/${taskId}/${itemIndex}/${subIndex}` };
}

function getImageMimeType(format, fallback = 'image/png') {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  if (format === 'png') return 'image/png';
  return fallback;
}

function parseAspectRatio(aspectRatio) {
  const match = String(aspectRatio || '').match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return undefined;

  const decimalPlaces = Math.max(
    (match[1].split('.')[1] || '').length,
    (match[2].split('.')[1] || '').length,
  );
  const multiplier = 10 ** decimalPlaces;
  const width = Math.round(Number(match[1]) * multiplier);
  const height = Math.round(Number(match[2]) * multiplier);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function getImageLayoutTargetSize(request) {
  const customSize = normalizeCustomImageSize(request.customSize, 3840);
  if (customSize) return parseImageSize(customSize);

  const requestedSize = getGptImageSize(request.outputSize, request.aspectRatio);
  if (request.protocol === 'openai' && request.imageApiFlavor !== 'xai-imagine' && requestedSize) {
    return parseImageSize(requestedSize);
  }

  // Every supported provider uses 1024x1024 for the 1K square preset.
  if (request.outputSize === '1K' && request.aspectRatio === '1:1') {
    return { width: 1024, height: 1024 };
  }

  return undefined;
}

function getCenteredAspectCrop(width, height, aspectRatio) {
  const ratio = parseAspectRatio(aspectRatio);
  if (!ratio || width <= 0 || height <= 0) return undefined;

  const scale = Math.floor(Math.min(width / ratio.width, height / ratio.height));
  if (scale <= 0) return undefined;

  const cropWidth = scale * ratio.width;
  const cropHeight = scale * ratio.height;
  return {
    left: Math.floor((width - cropWidth) / 2),
    top: Math.floor((height - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  };
}

/**
 * 校验品牌图片地址，只允许站内绝对路径或 HTTP(S) 资源地址。
 * @param value 环境变量中读取到的品牌图片地址。
 * @param fallback 配置缺失或地址无效时使用的默认地址。
 * @returns 可安全下发给浏览器加载的图片地址。
 */
function normalizeBrandAssetUrl(value, fallback) {
  const normalized = String(value || '').trim();
  if (!normalized) return fallback;
  if (normalized.startsWith('/') && !normalized.startsWith('//')) return normalized;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? normalized : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 读取平台名称、Logo、站点图标与镜像构建版本号的运行时品牌配置。
 * @param env 合并后的运行时环境变量对象。
 * @returns 可直接下发至前端和 PWA Manifest 的品牌配置。
 */
function resolvePlatformBranding(env = getRuntimeEnv()) {
  const configuredName = String(getRuntimeEnvValue(env, 'PLATFORM_NAME') || '').trim().slice(0, 120);
  return {
    platformName: configuredName || DEFAULT_PLATFORM_BRANDING.platformName,
    logoUrl: normalizeBrandAssetUrl(getRuntimeEnvValue(env, 'PLATFORM_LOGO_URL'), DEFAULT_PLATFORM_BRANDING.logoUrl),
    iconUrl: normalizeBrandAssetUrl(getRuntimeEnvValue(env, 'PLATFORM_ICON_URL'), DEFAULT_PLATFORM_BRANDING.iconUrl),
    icon192Url: normalizeBrandAssetUrl(getRuntimeEnvValue(env, 'PLATFORM_ICON_192_URL'), DEFAULT_PLATFORM_BRANDING.icon192Url),
    icon512Url: normalizeBrandAssetUrl(getRuntimeEnvValue(env, 'PLATFORM_ICON_512_URL'), DEFAULT_PLATFORM_BRANDING.icon512Url),
    maskableIconUrl: normalizeBrandAssetUrl(getRuntimeEnvValue(env, 'PLATFORM_MASKABLE_ICON_URL'), DEFAULT_PLATFORM_BRANDING.maskableIconUrl),
    platformVersion: DEFAULT_PLATFORM_BRANDING.platformVersion,
  };
}

/**
 * 根据当前品牌配置生成 PWA Manifest，确保安装后的名称和图标与页面一致。
 * @param branding 已校验的平台品牌配置。
 * @returns 可作为 Web App Manifest 返回的 JSON 对象。
 */
function buildPlatformManifest(branding) {
  return {
    id: '/',
    name: branding.platformName,
    short_name: branding.platformName,
    description: branding.platformName,
    start_url: '/',
    display: 'standalone',
    background_color: '#f5f5fa',
    theme_color: '#1a1a2e',
    orientation: 'any',
    icons: [
      { src: branding.icon192Url || branding.iconUrl, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: branding.icon512Url || branding.iconUrl, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: branding.maskableIconUrl || branding.icon512Url || branding.iconUrl, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

/**
 * Providers are asked for the requested layout first. This is a final guard for
 * OpenAI-compatible gateways that return an image with a different layout.
 */
async function enforceGeneratedImageLayout(imageBuffer, mimeType, request) {
  const metadata = await sharp(imageBuffer).metadata();
  const sourceWidth = metadata.width;
  const sourceHeight = metadata.height;
  if (!sourceWidth || !sourceHeight) {
    throw new Error('无法读取生成图片尺寸，无法确认输出比例');
  }

  const detectedMimeType = getImageMimeType(metadata.format, mimeType);
  const targetSize = getImageLayoutTargetSize(request);
  if (targetSize && (sourceWidth !== targetSize.width || sourceHeight !== targetSize.height)) {
    const result = await sharp(imageBuffer)
      .rotate()
      .resize(targetSize.width, targetSize.height, { fit: 'cover', position: 'centre' })
      .toBuffer({ resolveWithObject: true });
    console.warn(`[image-layout] 已归一化图片尺寸: ${sourceWidth}x${sourceHeight} -> ${targetSize.width}x${targetSize.height}`);
    return {
      buffer: result.data,
      mimeType: getImageMimeType(result.info.format, detectedMimeType),
    };
  }

  if (!targetSize && request.aspectRatio !== 'auto') {
    const crop = getCenteredAspectCrop(sourceWidth, sourceHeight, request.aspectRatio);
    if (crop && (crop.width !== sourceWidth || crop.height !== sourceHeight)) {
      const result = await sharp(imageBuffer)
        .rotate()
        .extract(crop)
        .toBuffer({ resolveWithObject: true });
      console.warn(`[image-layout] 已归一化图片比例: ${sourceWidth}x${sourceHeight} -> ${crop.width}x${crop.height}`);
      return {
        buffer: result.data,
        mimeType: getImageMimeType(result.info.format, detectedMimeType),
      };
    }
  }

  return { buffer: imageBuffer, mimeType: detectedMimeType };
}

function isPrivateIpv4(address) {
  const parts = String(address || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function parseIpv4Address(address) {
  const parts = String(address || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

function parseIpv6Hextets(address) {
  const raw = String(address || '').toLowerCase();
  if (!raw || raw.includes(':::')) return null;
  const [headRaw, tailRaw, extra] = raw.split('::');
  if (extra !== undefined) return null;
  const hasCompression = raw.includes('::');

  const parsePart = (part) => {
    if (!part) return [];
    const output = [];
    for (const segment of part.split(':')) {
      if (!segment) return null;
      if (segment.includes('.')) {
        const ipv4 = parseIpv4Address(segment);
        if (!ipv4) return null;
        output.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(segment)) return null;
      output.push(parseInt(segment, 16));
    }
    return output;
  };

  const head = parsePart(headRaw);
  const tail = parsePart(tailRaw || '');
  if (!head || !tail) return null;
  const missing = hasCompression ? 8 - head.length - tail.length : 0;
  if (missing < 0) return null;
  const hextets = hasCompression
    ? [...head, ...Array.from({ length: missing }, () => 0), ...tail]
    : head;
  return hextets.length === 8 ? hextets : null;
}

function ipv4FromLastHextets(hextets) {
  if (!Array.isArray(hextets) || hextets.length !== 8) return null;
  const high = hextets[6];
  const low = hextets[7];
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join('.');
}

function isIpv4MappedOrCompatiblePrivateIpv6(hextets) {
  if (!hextets) return true;
  const firstFiveZero = hextets.slice(0, 5).every(part => part === 0);
  const firstSixZero = firstFiveZero && hextets[5] === 0;
  const mappedIpv4 = firstFiveZero && hextets[5] === 0xffff;
  const compatibleIpv4 = firstSixZero && (hextets[6] !== 0 || hextets[7] !== 0);
  const nat64WellKnown = hextets[0] === 0x0064
    && hextets[1] === 0xff9b
    && hextets.slice(2, 6).every(part => part === 0);
  if (!mappedIpv4 && !compatibleIpv4 && !nat64WellKnown) return false;
  const ipv4 = ipv4FromLastHextets(hextets);
  return ipv4 ? isPrivateIpv4(ipv4) : true;
}

function isPrivateIpv6(address) {
  const normalized = String(address || '').toLowerCase();
  if (!normalized) return true;
  const ipv4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Mapped) return isPrivateIpv4(ipv4Mapped[1]);
  const hextets = parseIpv6Hextets(normalized);
  if (!hextets) return true;
  if (isIpv4MappedOrCompatiblePrivateIpv6(hextets)) return true;
  if (normalized === '::' || normalized === '::1') return true;
  const first = hextets[0];
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  return false;
}

function isPrivateIpAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

async function resolveSafeRemoteImageDownloadTarget(imageUrl) {
  let parsed;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new Error('远程图片 URL 无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('远程图片 URL 协议不允许');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) throw new Error('远程图片 URL 缺少主机名');
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (isPrivateIpAddress(hostname)) {
      throw new Error('远程图片 URL 指向内网或保留地址');
    }
    return {
      url: parsed,
      hostname,
      address: hostname,
      family: literalFamily,
    };
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('远程图片 URL 主机无法解析');
  for (const item of addresses) {
    if (isPrivateIpAddress(item.address)) {
      throw new Error('远程图片 URL 解析到内网或保留地址');
    }
  }
  const selected = addresses[0];
  const selectedFamily = selected.family === 6 ? 6 : 4;
  return {
    url: parsed,
    hostname,
    address: selected.address,
    family: selectedFamily,
  };
}

function createPinnedRemoteImageRequestOptions(target, headers = {}) {
  const requestHeaders = { ...headers };
  const hasHostHeader = Object.keys(requestHeaders).some(key => key.toLowerCase() === 'host');
  if (!hasHostHeader) requestHeaders.Host = target.url.host;

  return {
    protocol: target.url.protocol,
    hostname: target.address,
    port: target.url.port ? Number(target.url.port) : undefined,
    path: `${target.url.pathname}${target.url.search}`,
    method: 'GET',
    family: target.family,
    servername: net.isIP(target.hostname) ? undefined : target.hostname,
    headers: requestHeaders,
  };
}

function createNodeResponseHeaders(headers) {
  return {
    get(name) {
      const value = headers[String(name || '').toLowerCase()];
      if (Array.isArray(value)) return value.join(', ');
      return value === undefined ? null : String(value);
    },
  };
}

function fetchPinnedRemoteImage(target, headers = {}, options = {}) {
  const transport = target.url.protocol === 'https:' ? https : http;
  const requestOptions = createPinnedRemoteImageRequestOptions(target, headers);

  return new Promise((resolve, reject) => {
    throwIfAborted(options.signal);
    const req = transport.request(requestOptions, (res) => {
      const status = res.statusCode || 0;
      resolve({
        status,
        ok: status >= 200 && status < 300,
        headers: createNodeResponseHeaders(res.headers),
        body: res,
      });
    });
    const abort = () => {
      req.destroy(getAbortSignalReason(options.signal));
    };
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('远程图片下载超时'));
    });
    if (options.signal) {
      options.signal.addEventListener('abort', abort, { once: true });
      req.on('close', () => options.signal.removeEventListener('abort', abort));
    }
    req.end();
  });
}

async function drainRemoteImageResponseBody(response) {
  if (response?.body && typeof response.body.cancel === 'function') {
    await response.body.cancel().catch(() => undefined);
    return;
  }
  if (response?.body && typeof response.body.resume === 'function') {
    response.body.resume();
  }
}

function getHeaderObject(headers, imageUrl) {
  return typeof headers === 'function' ? headers(imageUrl) : (headers || {});
}

async function fetchRemoteImageWithRedirects(imageUrl, options = {}, redirectCount = 0) {
  throwIfAborted(options.signal);
  const target = await resolveSafeRemoteImageDownloadTarget(imageUrl);
  const response = await fetchPinnedRemoteImage(target, getHeaderObject(options.headers, imageUrl), { signal: options.signal });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    void drainRemoteImageResponseBody(response);
    if (redirectCount >= MAX_REMOTE_IMAGE_REDIRECTS) {
      throw new Error('远程图片重定向次数过多');
    }
    const location = response.headers.get('location');
    if (!location) throw new Error('远程图片重定向缺少 Location');
    const nextUrl = new URL(location, imageUrl).toString();
    return fetchRemoteImageWithRedirects(nextUrl, options, redirectCount + 1);
  }
  return response;
}

function parsePositiveContentLength(value) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readResponseBufferWithLimit(response, maxBytes = MAX_REMOTE_IMAGE_BYTES, signal) {
  throwIfAborted(signal);
  const contentLength = parsePositiveContentLength(response.headers.get('content-length'));
  if (contentLength !== undefined && contentLength > maxBytes) {
    await drainRemoteImageResponseBody(response);
    throw new Error(`远程图片超过大小限制: ${maxBytes} bytes`);
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`远程图片超过大小限制: ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  }

  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const value of response.body) {
      throwIfAborted(signal);
      if (!value) continue;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        throw new Error(`远程图片超过大小限制: ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`远程图片超过大小限制: ${maxBytes} bytes`);
    return buffer;
  }

  throw new Error('远程图片响应体不可读取');
}

async function downloadUrlToDisk(taskId, itemIndex, subIndex, imageUrl, options = {}) {
  const response = await fetchRemoteImageWithRedirects(imageUrl, {
    headers: (currentUrl) => {
      const headers = {};
      if (options.apiKey && shouldAuthorizeRemoteImageDownload(currentUrl, options.request)) {
        headers.Authorization = `Bearer ${options.apiKey}`;
      }
      return headers;
    },
    signal: options.signal,
  });
  if (!response.ok) {
    console.warn(`[image-download] 远程图片下载失败: status=${response.status} task=${taskId} item=${itemIndex} sub=${subIndex} url=${getSafeUrlLabel(imageUrl)}`);
    void drainRemoteImageResponseBody(response);
    throw new Error(`远程图片下载失败: ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || 'image/png';
  if (!/^image\//i.test(contentType) && !/^application\/octet-stream\b/i.test(contentType)) {
    await drainRemoteImageResponseBody(response);
    throw new Error(`远程图片类型不支持: ${contentType}`);
  }
  const buffer = await readResponseBufferWithLimit(response, MAX_REMOTE_IMAGE_BYTES, options.signal);
  const normalized = await enforceGeneratedImageLayout(buffer, contentType, options.request || {});
  return saveImageToDisk(taskId, itemIndex, subIndex, normalized.buffer, normalized.mimeType);
}

function getTaskImageFiles(taskId) {
  try {
    if (!fs.existsSync(IMAGE_DIR)) return [];
    const prefix = `${taskId}-`;
    return fs.readdirSync(IMAGE_DIR)
      .filter(name => name.startsWith(prefix))
      .map(name => path.join(IMAGE_DIR, name));
  } catch {
    return [];
  }
}

function deleteImageFile(filePath, _taskId) {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: true, reason: 'not_found' };
    }
    fs.unlinkSync(filePath);
    return { success: true };
  } catch (error) {
    console.warn(`[image-lifecycle] 删除文件失败: ${filePath}`, error?.message || error);
    return { success: false, reason: error?.message || String(error) };
  }
}

function deleteTaskImageFiles(taskId) {
  const files = getTaskImageFiles(taskId);
  let successCount = 0;
  let notFoundCount = 0;
  let failedCount = 0;
  for (const filePath of files) {
    const result = deleteImageFile(filePath, taskId);
    if (result.success && result.reason === 'not_found') {
      notFoundCount++;
    } else if (result.success) {
      successCount++;
    } else {
      failedCount++;
    }
  }
  console.log(`[image-lifecycle] 任务图片清理完成: taskId=${taskId}, total=${files.length}, success=${successCount}, notFound=${notFoundCount}, failed=${failedCount}`);
  return { total: files.length, success: successCount, notFound: notFoundCount, failed: failedCount };
}

function initDatabase() {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT,
      read_token_hash TEXT,
      error TEXT,
      warning TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS task_items (
      task_id TEXT NOT NULL,
      item_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      image_data TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (task_id, item_index)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_expires_at ON tasks(expires_at);
    CREATE INDEX IF NOT EXISTS idx_task_items_task_id ON task_items(task_id);
  `);
  const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name);
  if (!taskColumns.includes('read_token_hash')) {
    db.prepare('ALTER TABLE tasks ADD COLUMN read_token_hash TEXT').run();
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE tasks SET status = ? WHERE status = ?').run(TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED);
  db.prepare('UPDATE task_items SET status = ? WHERE status = ?').run(TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED);
  const interruptedIds = db.prepare(`
    SELECT id FROM tasks WHERE status IN (?, ?)
  `).all(TASK_STATUS.QUEUED, TASK_STATUS.PROCESSING).map(r => r.id);
  db.prepare(`
    UPDATE tasks
    SET status = 'failed', error = ?, completed_at = ?, expires_at = ?
    WHERE status IN (?, ?)
  `).run('服务器重启，任务已中断，请重新生成', now, new Date(Date.now() + TASK_TTL_MS).toISOString(), TASK_STATUS.QUEUED, TASK_STATUS.PROCESSING);
  for (const id of interruptedIds) {
    deleteTaskImageFiles(id);
  }
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function sendHttpError(res, error) {
  const headers = {};
  if (error.retryAfter) {
    headers['Retry-After'] = String(error.retryAfter);
  }
  // 413 时请求体可能仍在上传，保持 keep-alive 会让残留入站数据干扰下个请求；
  // 显式关闭连接，确保客户端能干净收到这条错误响应。
  if (error.statusCode === 413) {
    headers['Connection'] = 'close';
  }
  sendJson(res, error.statusCode, {
    error: normalizeError(error),
    code: error.code,
    retryAfter: error.retryAfter,
  }, headers);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
  }[ext] || 'application/octet-stream';
}

// 统一的文件流响应：必须挂 'error' 监听，否则流中途出错（文件被删 / EACCES /
// 磁盘错）会抛出未捕获异常拖垮整个进程。头已发出时只能断开连接。
function pipeFileToResponse(res, filePath, statusCode, headers) {
  const stream = fs.createReadStream(filePath);
  stream.on('error', error => {
    console.warn(`[static] 文件流读取失败: ${filePath}`, error?.message || error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    } else {
      res.destroy(error);
    }
  });
  res.writeHead(statusCode, headers);
  stream.pipe(res);
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(STATIC_DIR)) return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname || '/');
  } catch {
    decodedPath = (pathname || '/').replace(/%(?![0-9a-fA-F]{2})/g, '');
  }
  // 路径遍历防护：规范化后检测 .. 路径段，提前拒绝
  const normalizedPath = path.normalize(decodedPath);
  if (normalizedPath.includes('..')) return false;

  const candidates = [];
  if (normalizedPath.endsWith('/') || normalizedPath.endsWith(path.sep)) {
    candidates.push(path.join(STATIC_DIR, normalizedPath, 'index.html'));
  } else {
    candidates.push(path.join(STATIC_DIR, normalizedPath));
    candidates.push(path.join(STATIC_DIR, `${normalizedPath}.html`));
    candidates.push(path.join(STATIC_DIR, normalizedPath, 'index.html'));
  }

  const staticDirResolved = path.resolve(STATIC_DIR) + path.sep;
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(staticDirResolved) && resolved !== staticDirResolved.slice(0, -1)) continue;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;
    pipeFileToResponse(res, resolved, 200, { 'Content-Type': getContentType(resolved) });
    return true;
  }

  const notFound = path.join(STATIC_DIR, '404.html');
  if (fs.existsSync(notFound)) {
    pipeFileToResponse(res, notFound, 404, { 'Content-Type': 'text/html; charset=utf-8' });
    return true;
  }
  return false;
}

const SMALL_JSON_BODY_BYTES = 1 * 1024 * 1024;
const TASK_REQUEST_BODY_BYTES = 50 * 1024 * 1024;
const TEXT_PROXY_REQUEST_BODY_BYTES = TASK_REQUEST_BODY_BYTES;

function readJsonBody(req, { maxBytes = SMALL_JSON_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let rawBytes = 0;
    let aborted = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (aborted) return;
      rawBytes += Buffer.byteLength(chunk, 'utf8');
      if (rawBytes > maxBytes) {
        aborted = true;
        raw = ''; // 释放已缓冲内存
        // 不再 req.destroy()：直接重置连接会让客户端收到 ERR_CONNECTION_RESET，
        // 看不到任何错误信息。改为排空剩余入站数据，并以 413 优雅返回（catch -> sendHttpError）。
        req.resume();
        reject(createHttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大：参考图过多或分辨率过高，请减少参考图数量或降低分辨率后重试。'));
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('请求 JSON 格式无效'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 规范化任务执行异常，保留已标识的上游原始响应并限制内部错误详情长度。
 * @param error 任务执行期间捕获的异常对象或错误文本。
 * @returns 可安全写入任务状态并展示给用户的错误文本。
 */
function normalizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('上游服务错误')) {
    return truncateErrorMessage(message, MAX_UPSTREAM_ERROR_MESSAGE_CHARS);
  }
  if (/failed to fetch|fetch failed|networkerror|network request failed|load failed|network connection was lost|econnreset|socket hang up|terminated/i.test(message)) {
    return '网络连接失败。请检查服务器网络连接或稍后重试。';
  }
  if (/abort|timeout|timed out/i.test(message)) {
    return `请求超时（${REQUEST_TIMEOUT_MS / 1000}秒）。高分辨率图片生成需要更长时间，请稍后重试。`;
  }
  // 截断非预定义错误消息，避免泄露内部信息（文件路径、堆栈等）
  return truncateErrorMessage(message, 200);
}

function truncateErrorMessage(message, limit) {
  return message.length > limit ? `${message.slice(0, limit)}…` : message;
}

/**
 * 构建上游 HTTP 失败的展示前缀，并为网关超时提供重试指引。
 * @param status 上游响应的 HTTP 状态码。
 * @returns 不包含上游响应体的错误前缀。
 */
function getUpstreamHttpErrorPrefix(status) {
  return status === 504
    ? '上游服务错误（HTTP 504，请再次重试）'
    : `上游服务错误（HTTP ${status}）`;
}

function sanitizeUpstreamErrorBody(responseText) {
  const text = String(responseText || '').trim();
  if (!text) return '上游未返回错误详情';
  return truncateErrorMessage(text, MAX_UPSTREAM_ERROR_BODY_CHARS);
}

function buildUpstreamErrorMessage(responseText) {
  return `上游服务错误：${sanitizeUpstreamErrorBody(responseText)}`;
}

function buildUpstreamHttpErrorMessage(status, responseText) {
  return `${getUpstreamHttpErrorPrefix(status)}：${sanitizeUpstreamErrorBody(responseText)}`;
}

function validateEnumValue(value, validValues, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!validValues.has(value)) {
    throw new Error(`${fieldName} 参数无效`);
  }
  return value;
}

function validateProxyProtocol(value) {
  if (!VALID_PROTOCOLS.has(value)) {
    throw createHttpError(400, 'INVALID_PROTOCOL', '协议类型无效，必须为 google 或 openai');
  }
  return value;
}

function normalizeGptImageAdvancedParams(params = {}) {
  const quality = validateEnumValue(params.gptImageQuality, GPT_IMAGE_QUALITIES, 'quality');
  const style = validateEnumValue(params.gptImageStyle, GPT_IMAGE_STYLES, 'style');
  const background = validateEnumValue(params.gptImageBackground, GPT_IMAGE_BACKGROUNDS, 'background');
  const outputFormat = validateEnumValue(params.gptImageOutputFormat, GPT_IMAGE_OUTPUT_FORMATS, 'output_format');

  return {
    quality: quality || DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.quality,
    style: style || DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.style,
    background: background || DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.background,
    outputFormat: outputFormat || DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.outputFormat,
  };
}

function validateImageRequestLayout(body) {
  body.outputSize = String(body.outputSize || 'auto').trim() || 'auto';
  body.aspectRatio = String(body.aspectRatio || 'auto').trim() || 'auto';
  if (!VALID_OUTPUT_SIZES.has(body.outputSize)) throw new Error('图片尺寸无效');
  if (!VALID_ASPECT_RATIOS.has(body.aspectRatio)) throw new Error('图片比例无效');

  if (body.customSize === undefined || body.customSize === null || String(body.customSize).trim() === '') {
    body.customSize = undefined;
    return;
  }

  body.customSize = String(body.customSize).trim();
  const parsed = parseImageSize(body.customSize);
  if (!parsed || !isImageSizeWithinLimits(parsed.width, parsed.height, 3840)) {
    throw new Error('自定义图片尺寸无效');
  }
}

function isValidReferenceImageData(data) {
  const normalized = String(data || '').replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 === 1) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(normalized);
}

function validateImageReferences(body) {
  if (!Array.isArray(body.images)) {
    body.images = [];
    return;
  }
  if (body.images.length > MAX_REFERENCE_IMAGES) throw new Error(`参考图最多支持 ${MAX_REFERENCE_IMAGES} 张`);
  body.images = body.images.map((image, index) => {
    if (!image || typeof image !== 'object') throw new Error(`第 ${index + 1} 张参考图无效`);
    const mimeType = String(image.mimeType || '').trim().toLowerCase();
    const data = String(image.data || '').trim();
    if (!VALID_REFERENCE_IMAGE_MIME_TYPES.has(mimeType)) throw new Error('参考图格式仅支持 PNG、JPEG 或 WebP');
    if (!isValidReferenceImageData(data)) throw new Error(`第 ${index + 1} 张参考图数据无效`);
    return {
      data: data.replace(/\s+/g, ''),
      mimeType: mimeType === 'image/jpg' ? 'image/jpeg' : mimeType,
    };
  });
}

function validateCreatePayload(body) {
  if (!body || typeof body !== 'object') throw new Error('请求体不能为空');
  if (typeof body.apiKey !== 'string' || body.apiKey.trim().length === 0) throw new Error('缺少 API 密钥');
  if (!VALID_PROTOCOLS.has(body.protocol)) throw new Error('协议类型无效，必须为 google 或 openai');
  if (body.mode !== 'text-to-image' && body.mode !== 'image-to-image') throw new Error('任务模式无效');
  if (typeof body.prompt !== 'string') throw new Error('提示词不能为空');
  if (typeof body.model !== 'string' || body.model.trim().length === 0) throw new Error('模型名称不能为空');
  if (!Number.isInteger(body.parallelCount) || body.parallelCount < 1 || body.parallelCount > MAX_PARALLEL_COUNT) throw new Error('并发数量无效');
  if (body.imageApiFlavor !== undefined && !IMAGE_API_FLAVORS.has(body.imageApiFlavor)) throw new Error('图片 API 类型无效');
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) throw new Error('温度参数无效');

  validateImageRequestLayout(body);
  validateImageReferences(body);
  if (body.mode === 'image-to-image' && body.images.length === 0) throw new Error('图生图至少需要 1 张参考图');
  if (!Array.isArray(body.promptVariants)) {
    body.promptVariants = [];
  } else {
    body.promptVariants = body.promptVariants
      .slice(0, body.parallelCount)
      .map(item => typeof item === 'string' ? item.trim() : '');
  }
  if (!Array.isArray(body.effectivePrompts)) {
    body.effectivePrompts = [];
  } else {
    body.effectivePrompts = body.effectivePrompts
      .slice(0, body.parallelCount)
      .map(item => typeof item === 'string' ? item.trim() : '');
  }
  const hasPromptText = body.prompt.trim().length > 0;
  const hasCompleteEffectivePrompts = (
    body.effectivePrompts.length === body.parallelCount &&
    body.effectivePrompts.every(item => item.trim().length > 0)
  );
  if (!hasPromptText && !hasCompleteEffectivePrompts) throw new Error('提示词不能为空');
  body.baseUrl = resolveFixedRkapiGatewayBaseUrl();
  body.streamImages = body.protocol === 'openai' ? Boolean(body.streamImages) : false;
  if (body.imageApiFlavor === 'xai-imagine') {
    if (body.protocol !== 'openai') throw new Error('xAI Imagine 仅支持 OpenAI 兼容协议');
    if (!XAI_IMAGINE_OUTPUT_SIZES.has(body.outputSize)) throw new Error('xAI Imagine 仅支持 1K 或 2K 分辨率');
    if (!XAI_IMAGINE_ASPECT_RATIOS.has(body.aspectRatio)) throw new Error('xAI Imagine 图片比例无效');
    if (body.customSize) throw new Error('xAI Imagine 不支持自定义像素尺寸');
    if (body.images.length > 1) throw new Error('xAI Imagine 首版仅支持 1 张参考图');
    body.streamImages = false;
  }
}

/**
 * 将请求体转换为可持久化的任务请求快照，避免保存 API Key 和参考图 Base64 数据。
 * @param body 已校验的创建任务请求体。
 * @param parallelCount 此服务端任务包含的图片数量。
 * @param promptVariants 此服务端任务使用的提示词变体列表。
 * @param effectivePrompts 此服务端任务每张图使用的完整提示词列表。
 * @returns 可写入 tasks.request_json 的安全任务请求对象。
 */
function buildTaskRequestForDb(body, parallelCount = body.parallelCount, promptVariants = body.promptVariants, effectivePrompts = body.effectivePrompts) {
  return {
    mode: body.mode,
    source: 'flyreq',
    protocol: body.protocol,
    imageApiFlavor: body.imageApiFlavor,
    baseUrl: body.baseUrl,
    prompt: body.prompt,
    outputSize: body.outputSize,
    customSize: body.customSize,
    aspectRatio: body.aspectRatio,
    temperature: body.temperature,
    model: body.model,
    gptImageQuality: body.gptImageQuality,
    gptImageStyle: body.gptImageStyle,
    gptImageBackground: body.gptImageBackground,
    gptImageOutputFormat: body.gptImageOutputFormat,
    streamImages: body.streamImages,
    parallelCount,
    promptVariants,
    effectivePrompts: Array.isArray(effectivePrompts)
      ? effectivePrompts.slice(0, parallelCount).map(item => typeof item === 'string' ? item.trim() : '')
      : [],
    images: body.images.map(img => ({ mimeType: img.mimeType })),
  };
}

/**
 * 为已写入数据库的任务登记内存运行状态与来源待处理计数。
 * @param taskId 服务端任务标识。
 * @param apiKey 本次生成所需的 API Key，仅保存在内存。
 * @param images 原始参考图数据，仅保存在内存。
 * @param source 限流和待处理统计使用的请求来源。
 * @returns 无返回值，任务会进入待调度队列。
 */
function registerTaskRuntimeState(taskId, apiKey, images, source, pendingCost = 1) {
  const normalizedPendingCost = normalizeRateLimitCost(pendingCost);
  apiKeys.set(taskId, apiKey);
  taskRefImages.set(taskId, images);
  taskSources.set(taskId, { ...source, pendingCost: normalizedPendingCost });
  if (source.ip) pendingCountByIp.set(source.ip, (pendingCountByIp.get(source.ip) || 0) + normalizedPendingCost);
  if (source.apiKeyHash) pendingCountByApiKeyHash.set(source.apiKeyHash, (pendingCountByApiKeyHash.get(source.apiKeyHash) || 0) + normalizedPendingCost);
  queue.push(taskId);
}

/**
 * 创建一个可包含多张图片的兼容旧接口任务。
 * @param body 客户端提交的单任务请求体。
 * @param req 原始 HTTP 请求，用于限流来源识别。
 * @returns 新建任务的服务端任务标识。
 */
function createTask(body, req) {
  validateCreatePayload(body);
  const limitConfig = getLimitConfig();
  if (isRejectNewTasksEnabled()) {
    throw createHttpError(503, 'SERVER_NOT_ACCEPTING_TASKS', LIMIT_ERROR_MESSAGES.notAcceptingTasks, limitConfig.retryAfterSeconds);
  }
  const requestedTasks = body.parallelCount;
  enforceQueueCapacity(null, limitConfig, body.parallelCount);
  const source = enforceRateLimit(req, body, limitConfig, requestedTasks);
  enforceQueueCapacity(source, limitConfig, body.parallelCount, requestedTasks);

  const taskId = randomUUID();
  const readToken = generateTaskReadToken();
  const readTokenHash = hashTaskReadToken(readToken);
  const now = new Date().toISOString();
  const requestForDb = buildTaskRequestForDb(body);
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO tasks (id, status, mode, request_json, read_token_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, TASK_STATUS.QUEUED, body.mode, JSON.stringify(requestForDb), readTokenHash, now);
    const insertItem = db.prepare(`
      INSERT INTO task_items (task_id, item_index, status, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (let index = 0; index < body.parallelCount; index++) {
      insertItem.run(taskId, index, TASK_STATUS.QUEUED, now);
    }
  });
  tx();

  registerTaskRuntimeState(taskId, body.apiKey, body.images, source, requestedTasks);
  broadcastTask(taskId);
  broadcastQueueStatus();
  drainQueue();
  return { taskId, readToken };
}

/**
 * 原子创建一组独立单图任务，确保多图请求不会出现部分入队。
 * @param body 客户端提交的批量图片请求体，parallelCount 表示独立任务数量。
 * @param req 原始 HTTP 请求，用于限流来源识别。
 * @returns 按图片序号排序的独立服务端任务标识列表。
 */
function createTaskBatch(body, req) {
  validateCreatePayload(body);
  const limitConfig = getLimitConfig();
  if (isRejectNewTasksEnabled()) {
    throw createHttpError(503, 'SERVER_NOT_ACCEPTING_TASKS', LIMIT_ERROR_MESSAGES.notAcceptingTasks, limitConfig.retryAfterSeconds);
  }
  const requestedTasks = body.parallelCount;
  enforceQueueCapacity(null, limitConfig, body.parallelCount, requestedTasks);
  const source = enforceRateLimit(req, body, limitConfig, requestedTasks);
  enforceQueueCapacity(source, limitConfig, body.parallelCount, requestedTasks);

  const now = new Date().toISOString();
  const tasks = Array.from({ length: body.parallelCount }, (_, index) => {
    const promptVariant = body.promptVariants[index];
    const effectivePrompt = body.effectivePrompts[index];
    const requestBody = effectivePrompt
      ? { ...body, prompt: effectivePrompt, promptVariants: [] }
      : body;
    return {
      taskId: randomUUID(),
      readToken: generateTaskReadToken(),
      requestForDb: buildTaskRequestForDb(requestBody, 1, effectivePrompt ? [] : (promptVariant ? [promptVariant] : []), []),
    };
  });
  const tx = db.transaction(() => {
    const insertTask = db.prepare(`
      INSERT INTO tasks (id, status, mode, request_json, read_token_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertItem = db.prepare(`
      INSERT INTO task_items (task_id, item_index, status, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const task of tasks) {
      insertTask.run(task.taskId, TASK_STATUS.QUEUED, body.mode, JSON.stringify(task.requestForDb), hashTaskReadToken(task.readToken), now);
      insertItem.run(task.taskId, 0, TASK_STATUS.QUEUED, now);
    }
  });
  tx();

  for (const task of tasks) {
    registerTaskRuntimeState(task.taskId, body.apiKey, body.images, source);
    broadcastTask(task.taskId);
  }
  broadcastQueueStatus();
  drainQueue();
  return tasks.map(({ taskId, readToken }) => ({ taskId, readToken }));
}

function roundToMultiple(value, multiple) {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function floorToMultiple(value, multiple) {
  return Math.max(multiple, Math.floor(value / multiple) * multiple);
}

function parseImageSize(size) {
  const match = String(size || '').match(/^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/);
  if (!match) return undefined;

  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
}

function isImageSizeWithinLimits(width, height, maxSide) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;

  const limit = typeof maxSide === 'number' && maxSide > 0 ? maxSide : Number.POSITIVE_INFINITY;
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  const pixels = width * height;

  return (
    longSide <= limit &&
    width % CUSTOM_IMAGE_SIZE_LIMITS.multiple === 0 &&
    height % CUSTOM_IMAGE_SIZE_LIMITS.multiple === 0 &&
    longSide / shortSide <= CUSTOM_IMAGE_SIZE_LIMITS.maxAspectRatio &&
    pixels >= CUSTOM_IMAGE_SIZE_LIMITS.minPixels &&
    pixels <= CUSTOM_IMAGE_SIZE_LIMITS.maxPixels
  );
}

function getGptImageSize(outputSize, aspectRatio) {
  if (outputSize === 'auto' || outputSize === '512' || aspectRatio === 'auto') return undefined;
  const match = String(aspectRatio || '').match(/^(\d+):(\d+)$/);
  if (!match) return undefined;

  const ratioWidth = Number(match[1]);
  const ratioHeight = Number(match[2]);
  if (!ratioWidth || !ratioHeight) return undefined;

  let width;
  let height;
  if (outputSize === '1K') {
    const shortSide = 1024;
    width = ratioWidth > ratioHeight
      ? roundToMultiple(shortSide * ratioWidth / ratioHeight, 16)
      : shortSide;
    height = ratioWidth > ratioHeight
      ? shortSide
      : roundToMultiple(shortSide * ratioHeight / ratioWidth, 16);
  } else {
    if (outputSize !== '2K' && outputSize !== '4K') return undefined;
    const longSide = outputSize === '2K' ? 2048 : 3840;
    width = ratioWidth > ratioHeight
      ? longSide
      : roundToMultiple(longSide * ratioWidth / ratioHeight, 16);
    height = ratioWidth > ratioHeight
      ? roundToMultiple(longSide * ratioHeight / ratioWidth, 16)
      : longSide;
  }

  if (!isImageSizeWithinLimits(width, height, 3840)) {
    const maxLongSideByPixels = ratioWidth >= ratioHeight
      ? Math.sqrt(CUSTOM_IMAGE_SIZE_LIMITS.maxPixels * ratioWidth / ratioHeight)
      : Math.sqrt(CUSTOM_IMAGE_SIZE_LIMITS.maxPixels * ratioHeight / ratioWidth);
    const longSide = floorToMultiple(Math.min(3840, maxLongSideByPixels), 16);
    width = ratioWidth >= ratioHeight
      ? longSide
      : floorToMultiple(longSide * ratioWidth / ratioHeight, 16);
    height = ratioWidth >= ratioHeight
      ? floorToMultiple(longSide * ratioHeight / ratioWidth, 16)
      : longSide;
  }

  if (!isImageSizeWithinLimits(width, height, 3840)) return undefined;
  return `${width}x${height}`;
}

function normalizeCustomImageSize(size, maxSide) {
  const parsed = parseImageSize(size);
  if (!parsed) return undefined;

  const limit = typeof maxSide === 'number' && maxSide > 0 ? maxSide : Number.POSITIVE_INFINITY;
  const width = Math.min(roundToMultiple(parsed.width, CUSTOM_IMAGE_SIZE_LIMITS.multiple), limit);
  const height = Math.min(roundToMultiple(parsed.height, CUSTOM_IMAGE_SIZE_LIMITS.multiple), limit);
  if (!isImageSizeWithinLimits(width, height, maxSide)) return undefined;

  return `${width}x${height}`;
}

function getSupportedGptImageSize(model, outputSize, aspectRatio) {
  return getGptImageSize(outputSize, aspectRatio);
}

function resolveGptImageRequestSize(request) {
  const customSize = normalizeCustomImageSize(request.customSize, 3840);
  if (customSize) return customSize;
  return getSupportedGptImageSize(request.model, request.outputSize, request.aspectRatio);
}

function getGptImageRequestAdvancedParams(request) {
  return normalizeGptImageAdvancedParams(request);
}

function createGptImageRequestInit(apiKey, request, resolvedSize, options = {}) {
  const prompt = request.prompt;
  const advancedParams = getGptImageRequestAdvancedParams(request);
  const stream = Boolean(options.stream);

  if (request.mode === 'image-to-image') {
    const formData = new FormData();
    formData.append('model', request.model);
    formData.append('prompt', prompt);
    formData.append('n', '1');
    if (stream) {
      formData.append('stream', 'true');
    }
    if (advancedParams) {
      formData.append('quality', advancedParams.quality);
      formData.append('background', advancedParams.background);
      formData.append('output_format', advancedParams.outputFormat);
      if (advancedParams.style === 'vivid' || advancedParams.style === 'natural') {
        formData.append('style', advancedParams.style);
      }
    }
    if (resolvedSize) {
      formData.append('size', resolvedSize);
    }

    request.images.forEach((img, index) => {
      const mimeType = img.mimeType || 'image/png';
      const extension = mimeType.split('/')[1] || 'png';
      const bytes = Buffer.from(img.data, 'base64');
      const blob = new Blob([bytes], { type: mimeType });
      formData.append('image', blob, `image-${index}.${extension}`);
    });

    return {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
      signal: options.signal,
    };
  }

  const payload = {
    prompt,
    model: request.model,
    ...(stream ? { stream: true } : {}),
    ...(resolvedSize ? { size: resolvedSize } : {}),
    ...(advancedParams ? {
      quality: advancedParams.quality,
      background: advancedParams.background,
      output_format: advancedParams.outputFormat,
      ...(advancedParams.style === 'vivid' || advancedParams.style === 'natural' ? { style: advancedParams.style } : {}),
    } : {}),
    ...(request.images.length > 0 ? { image: request.images.map(img => `data:${img.mimeType};base64,${img.data}`) } : {}),
  };

  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  };
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isLikelyHtmlResponse(text) {
  const trimmed = String(text || '').trim().toLowerCase();
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || trimmed.startsWith('<head') || trimmed.startsWith('<body');
}

function getMessageFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();

  const error = payload.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message.trim()) return error.message.trim();
    if (typeof error.code === 'string' && error.code.trim()) return error.code.trim();
  }

  return '';
}

function getErrorMessageFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.error) return getMessageFromPayload(payload);

  const type = typeof payload.type === 'string' ? payload.type.toLowerCase() : '';
  if (type === 'error' || type === 'upstream_error') return getMessageFromPayload(payload);

  return '';
}

function normalizeImagePayloadValue(imageData) {
  if (!imageData || typeof imageData !== 'string') return undefined;
  if (imageData.startsWith('data:image')) return imageData.split(',')[1] || imageData;
  if (/^https?:\/\//i.test(imageData)) return `URL:${imageData}`;
  return imageData;
}

function getImagePayloadValue(data, depth = 0) {
  if (!data || depth > 3) return undefined;
  if (Array.isArray(data)) {
    for (const item of data) {
      const value = getImagePayloadValue(item, depth + 1);
      if (value) return value;
    }
    return undefined;
  }
  if (typeof data !== 'object') return undefined;

  const firstImage = Array.isArray(data.data)
    ? data.data.find(item => item && typeof item === 'object' && (item.b64_json || item.url || item.image_url))
    : undefined;
  const imageData = firstImage?.b64_json || firstImage?.url || firstImage?.image_url
    || data.b64_json || data.url || data.image_url;
  if (imageData) return imageData;

  return getImagePayloadValue(data.result, depth + 1)
    || getImagePayloadValue(data.response, depth + 1)
    || getImagePayloadValue(data.output, depth + 1);
}

function extractImagePayload(data) {
  const imageData = normalizeImagePayloadValue(getImagePayloadValue(data));
  if (!imageData) throw new Error('响应中无图片数据');
  return imageData;
}

function parseImageEventStream(text) {
  const payloads = [];
  let dataLines = [];

  const flush = () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n').trim();
    dataLines = [];
    if (!raw || raw === '[DONE]') return;
    const parsed = parseJsonSafely(raw);
    if (parsed) payloads.push(parsed);
  };

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();

  return payloads;
}

function isPartialImageEvent(payload) {
  const type = typeof payload?.type === 'string' ? payload.type.toLowerCase() : '';
  return type.includes('partial');
}

function extractImagePayloadFromEventStream(text) {
  const payloads = parseImageEventStream(text);
  const errorMessage = payloads.map(getErrorMessageFromPayload).find(Boolean);

  for (const payload of [...payloads].reverse()) {
    if (isPartialImageEvent(payload)) continue;
    try {
      return extractImagePayload(payload);
    } catch {
      // Keep scanning earlier events.
    }
  }

  for (const payload of [...payloads].reverse()) {
    if (!isPartialImageEvent(payload)) continue;
    try {
      return extractImagePayload(payload);
    } catch {
      // Keep scanning earlier partial events.
    }
  }

  if (errorMessage) throw new Error(errorMessage);
  throw new Error('响应中无图片数据');
}

function isImageEventStreamResponse(response) {
  return String(response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
}

function notifyImageSseResponse(options) {
  if (typeof options?.onSseConfirmed !== 'function') return;
  try {
    options.onSseConfirmed();
  } catch (error) {
    console.warn('[image-stream] 记录 SSE 状态失败:', error?.message || error);
  }
}

async function readResponseTextWithAbort(response, signal) {
  const controller = new AbortController();
  const abortFromExternalSignal = () => {
    if (!controller.signal.aborted) {
      controller.abort(getAbortSignalReason(signal));
    }
  };
  if (signal?.aborted) {
    abortFromExternalSignal();
  } else if (signal) {
    signal.addEventListener('abort', abortFromExternalSignal, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(new Error('请求超时')), REQUEST_TIMEOUT_MS);

  try {
    throwIfAborted(controller.signal);
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const cancelReader = () => {
        void reader.cancel(getAbortSignalReason(controller.signal)).catch(() => undefined);
      };
      controller.signal.addEventListener('abort', cancelReader, { once: true });
      try {
        for (;;) {
          throwIfAborted(controller.signal);
          const { done, value } = await reader.read();
          throwIfAborted(controller.signal);
          if (done) break;
          if (value) text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
      } finally {
        controller.signal.removeEventListener('abort', cancelReader);
        reader.releaseLock();
      }
    }
    return await response.text();
  } finally {
    if (signal) signal.removeEventListener('abort', abortFromExternalSignal);
    clearTimeout(timeout);
  }
}

async function parseGptImageResponse(response, signal) {
  const isEventStream = isImageEventStreamResponse(response);
  const responseText = await readResponseTextWithAbort(response, signal);

  if (!response.ok) {
    throw new Error(buildUpstreamHttpErrorMessage(response.status, responseText));
  }

  if (isEventStream) {
    try {
      return extractImagePayloadFromEventStream(responseText);
    } catch {
      throw new Error(buildUpstreamErrorMessage(responseText));
    }
  }

  if (isLikelyHtmlResponse(responseText)) {
    throw new Error(buildUpstreamErrorMessage(responseText));
  }

  const data = parseJsonSafely(responseText);
  if (!data) {
    throw new Error(buildUpstreamErrorMessage(responseText));
  }

  const errorMessage = getErrorMessageFromPayload(data);
  if (errorMessage) throw new Error(buildUpstreamErrorMessage(responseText));

  return extractImagePayload(data);
}

async function requestGptImage(apiKey, request, resolvedSize, options = {}) {
  const signal = options.signal;
  const baseUrl = options.baseUrl || resolveFlyreqApiBaseUrl();
  const endpoint = request.mode === 'image-to-image'
    ? '/v1/images/edits'
    : '/v1/images/generations';
  const stream = Boolean(options.stream);
  const url = appendProtocolApiPath('openai', baseUrl, endpoint);
  logImageRequestUrl('openai', request.model, url);

  const response = await fetchWithTimeout(
    url,
    createGptImageRequestInit(apiKey, request, resolvedSize, { ...options, stream })
  );
  const usesSse = isImageEventStreamResponse(response);
  if (usesSse) notifyImageSseResponse(options);
  try {
    return { image: await parseGptImageResponse(response, signal), usesSse };
  } catch (error) {
    if (usesSse && error && typeof error === 'object') {
      error.usesSse = true;
    }
    throw error;
  }
}

async function requestXaiImagineImage(apiKey, request, options = {}) {
  const signal = options.signal;
  const baseUrl = options.baseUrl || 'https://api.x.ai';
  const endpoint = getXaiImagineEndpoint(request.mode);
  const url = appendProtocolApiPath('openai', baseUrl, endpoint);
  logImageRequestUrl('xai-imagine', request.model, url);

  for (let attempt = 0; attempt <= XAI_IMAGINE_MAX_RETRIES; attempt++) {
    await waitForXaiImagineRequestSlot(apiKey, options.signal);
    const response = await fetchWithTimeout(url, createXaiImagineRequestInit(apiKey, request, { signal: options.signal }));
    if (response.status !== 429 || attempt === XAI_IMAGINE_MAX_RETRIES) {
      const usesSse = isImageEventStreamResponse(response);
      if (usesSse) notifyImageSseResponse(options);
      try {
        return { image: await parseGptImageResponse(response, signal), usesSse };
      } catch (error) {
        if (usesSse && error && typeof error === 'object') {
          error.usesSse = true;
        }
        throw error;
      }
    }

    const retryDelayMs = getRetryAfterDelayMs(response);
    await readResponseTextWithAbort(response, signal);
    console.warn(`[xai-imagine] 收到 429，${Math.ceil(retryDelayMs / 1000)} 秒后重试`);
    await delay(retryDelayMs, options.signal);
  }

  throw new Error('xAI Imagine 请求重试次数已耗尽');
}

// ===== 加强网络连接：启用 TCP keepalive，防止 Docker 回环连接被静默断开 =====
// Node.js 内置 fetch 基于 undici，默认不发送 TCP keepalive，
// 导致长时间等待响应（如 4K 图片生成）时连接被 Docker 网络层丢弃。
// 通过 setGlobalDispatcher 配置 undici Agent 的 keepalive 和超时参数。
try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: 60 * 1000,         // 空闲连接保持 60 秒
    keepAliveMaxTimeout: 10 * 60 * 1000, // 最大保持 10 分钟
    connect: {
      keepAlive: true,
      keepAliveInitialDelay: 15000,      // 15 秒后开始发送 TCP keepalive 探测
    },
    bodyTimeout: REQUEST_TIMEOUT_MS,     // 等待响应体的超时（与 abort 超时一致）
    headersTimeout: REQUEST_TIMEOUT_MS,  // 图片生成可能长时间等待响应头，需与任务超时一致
  }));
  console.log('[network] undici Agent 已配置: TCP keepalive=15s, timeout=30min');
} catch (e) {
  console.warn('[network] undici Agent 配置失败，使用默认设置:', e?.message || e);
}

function createRequestAbortSignal(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('客户端连接已断开'));
    }
  };
  res.on('close', abort);
  res.on('error', abort);
  req.on('aborted', abort);
  return {
    signal: controller.signal,
    cleanup() {
      res.off('close', abort);
      res.off('error', abort);
      req.off('aborted', abort);
    },
  };
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const externalSignal = init.signal;
  const abortFromExternalSignal = () => {
    if (!controller.signal.aborted) {
      controller.abort(externalSignal?.reason || new Error('请求已取消'));
    }
  };
  if (externalSignal?.aborted) {
    abortFromExternalSignal();
  } else if (externalSignal) {
    externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(new Error('请求超时')), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      headers: createOutboundHeaders(init?.headers),
      signal: controller.signal,
    });
  } finally {
    if (externalSignal) externalSignal.removeEventListener('abort', abortFromExternalSignal);
    clearTimeout(timeout);
  }
}

async function generateFlyreqImage(apiKey, request, options = {}) {
  // 开源版：根据前端传入的 protocol 字段路由到对应的 API 协议
  const baseUrlDetails = request.baseUrl
    ? resolveAndLogOutboundBaseUrl('图片生成', request.protocol, request.baseUrl)
    : { baseUrl: resolveFlyreqApiBaseUrl(), originalBaseUrl: '', rewritten: false };
  const baseUrl = baseUrlDetails.baseUrl;
  if (request.imageApiFlavor === 'xai-imagine') {
    return requestXaiImagineImage(apiKey, request, { baseUrl, onSseConfirmed: options.onSseConfirmed, signal: options.signal });
  }
  if (request.protocol === 'openai') {
    return requestGptImage(apiKey, request, resolveGptImageRequestSize(request), {
      baseUrl,
      stream: Boolean(request.streamImages),
      onSseConfirmed: options.onSseConfirmed,
      signal: options.signal,
    });
  }
  // 默认走 Google Gemini 协议
  return { image: await generateFlyreqGeminiImage(apiKey, request, { baseUrl, signal: options.signal }), usesSse: false };
}

function extractGeminiImagePayload(data) {
  const imagePart = data?.candidates?.[0]?.content?.parts?.find(part => part?.inlineData?.data || part?.inline_data?.data);
  const inlineData = imagePart?.inlineData || imagePart?.inline_data;
  if (!inlineData?.data) throw new Error('响应中无图片数据');
  return inlineData.data;
}

async function generateFlyreqGeminiImage(apiKey, request, options = {}) {
  const signal = options.signal;
  const baseUrl = options.baseUrl || resolveFlyreqApiBaseUrl();
  const parts = [
    { text: request.prompt },
    ...request.images.map(img => ({ inlineData: { data: img.data, mimeType: img.mimeType } })),
  ];
  const url = appendProtocolApiPath('google', baseUrl, `/v1beta/models/${encodeURIComponent(request.model)}:generateContent`);
  logImageRequestUrl('google', request.model, url);
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
        responseModalities: ['IMAGE'],
        imageConfig: { imageSize: request.outputSize, aspectRatio: request.aspectRatio },
      },
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const responseText = await readResponseTextWithAbort(response, signal);
    throw new Error(buildUpstreamHttpErrorMessage(response.status, responseText));
  }

  const responseText = await readResponseTextWithAbort(response, signal);
  if (isLikelyHtmlResponse(responseText)) {
    throw new Error(buildUpstreamErrorMessage(responseText));
  }
  const data = parseJsonSafely(responseText);
  if (!data) {
    throw new Error(buildUpstreamErrorMessage(responseText));
  }
  const errorMessage = getErrorMessageFromPayload(data);
  if (errorMessage) {
    throw new Error(buildUpstreamErrorMessage(responseText));
  }
  return extractGeminiImagePayload(data);
}

function drainQueue() {
  const maxConcurrency = getMaxServerConcurrency();
  while (queue.length > 0) {
    const taskId = queue[0];
    const task = db.prepare('SELECT request_json FROM tasks WHERE id = ?').get(taskId);
    const req = task ? JSON.parse(task.request_json) : null;
    const imageSlots = req?.parallelCount || 1;

    // 容量足够 → 放行。容量不足时唯一例外：当前空闲（activeCount===0）且该任务
    // 自身就超过总并发，允许其独占运行（否则永远无法被调度）；其余情况一律等待
    // 在飞任务腾出名额。
    const fitsWithinLimit = activeCount + imageSlots <= maxConcurrency;
    const oversizedTaskCanRunAlone = activeCount === 0 && imageSlots > maxConcurrency;
    if (!fitsWithinLimit && !oversizedTaskCanRunAlone) break;

    queue.shift();
    activeCount += imageSlots;
    runTask(taskId).finally(() => {
      activeCount -= imageSlots;
      drainQueue();
    });
  }
}

function recordTaskSseResponse(taskId, requestCount) {
  const task = db.prepare('SELECT status, result_json FROM tasks WHERE id = ?').get(taskId);
  if (!task || task.status !== 'processing') return;

  const parsedResult = task.result_json ? parseJsonSafely(task.result_json) : null;
  const result = parsedResult && typeof parsedResult === 'object' && !Array.isArray(parsedResult)
    ? parsedResult
    : {};
  const requests = Number.isInteger(requestCount) && requestCount > 0 ? requestCount : 1;
  const previousResponses = Number.isInteger(result.sse?.responses) ? result.sse.responses : 0;
  if (previousResponses >= requests) return;

  result.sse = { responses: previousResponses + 1, requests };
  db.prepare('UPDATE tasks SET result_json = ? WHERE id = ?').run(JSON.stringify(result), taskId);
  broadcastTask(taskId);
}

/**
 * 记录每次图片生成实际发往上游的完整请求地址。
 * @param protocol 图片生成协议或图片 API 类型。
 * @param model 实际发送给上游的模型 ID。
 * @param url 最终请求 URL，不包含 API Key 等敏感信息。
 * @returns 无返回值。
 */
function logImageRequestUrl(protocol, model, url) {
  console.info(`[image-request] 协议=${protocol} 模型=${model} 最终请求URL=${getSafeUrlLabel(url)}`);
}

async function generateSingleImage(apiKey, request, taskId, index, signal) {
  let usesSse = false;
  try {
    const effectivePrompt = typeof request.effectivePrompts?.[index] === 'string'
      ? request.effectivePrompts[index].trim()
      : '';
    const variantPrompt = typeof request.promptVariants?.[index] === 'string'
      ? request.promptVariants[index].trim()
      : '';
    const requestForImage = effectivePrompt
      ? { ...request, prompt: effectivePrompt }
      : variantPrompt
      ? { ...request, prompt: `${request.prompt}\n\n本张图要求：\n${variantPrompt}` }
      : request;
    const generated = await generateFlyreqImage(apiKey, requestForImage, {
      onSseConfirmed: () => recordTaskSseResponse(taskId, request.parallelCount),
      signal,
    });
    usesSse = generated.usesSse;
    const image = generated.image;
    const expanded = image.startsWith('MULTI_URL:') ? image.substring(10).split('|||').map(url => `URL:${url}`) : [image];
    const diskRefs = [];
    for (let subIdx = 0; subIdx < expanded.length; subIdx++) {
      const img = expanded[subIdx];
      if (img.startsWith('URL:')) {
        const remoteUrl = img.substring(4);
        const result = await downloadUrlToDisk(taskId, index, subIdx, remoteUrl, { apiKey, request: requestForImage, signal });
        diskRefs.push(`URL:${result.httpUrl}`);
      } else {
        const buffer = Buffer.from(img, 'base64');
        const normalized = await enforceGeneratedImageLayout(buffer, 'image/png', requestForImage);
        const result = saveImageToDisk(taskId, index, subIdx, normalized.buffer, normalized.mimeType);
        diskRefs.push(`URL:${result.httpUrl}`);
      }
    }
    db.prepare("UPDATE task_items SET status = 'completed', image_data = ?, completed_at = ? WHERE task_id = ? AND item_index = ?")
      .run(JSON.stringify(diskRefs), new Date().toISOString(), taskId, index);
    return { success: true, images: diskRefs, usesSse };
  } catch (error) {
    const message = normalizeError(error);
    db.prepare("UPDATE task_items SET status = 'failed', error = ?, completed_at = ? WHERE task_id = ? AND item_index = ?")
      .run(message, new Date().toISOString(), taskId, index);
    return { success: false, error: message, usesSse: usesSse || Boolean(error?.usesSse) };
  }
}

async function runTask(taskId) {
  const abortController = new AbortController();
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    const apiKey = apiKeys.get(taskId);
    if (!task || !apiKey || ![TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED].includes(task.status)) {
      return;
    }

    taskAbortControllers.set(taskId, abortController);

    const request = JSON.parse(task.request_json);
    const refImages = taskRefImages.get(taskId);
    if (refImages && refImages.length > 0) {
      request.images = refImages;
    }
    db.prepare("UPDATE tasks SET status = 'processing' WHERE id = ?").run(taskId);
    broadcastTask(taskId);
    broadcastQueueStatus();

    // 所有图片标记为 processing
    for (let index = 0; index < request.parallelCount; index++) {
      db.prepare("UPDATE task_items SET status = 'processing', created_at = ? WHERE task_id = ? AND item_index = ?")
        .run(new Date().toISOString(), taskId, index);
    }

    // 真正并发生成所有图片
    const itemResults = await Promise.allSettled(
      Array.from({ length: request.parallelCount }, (_, index) =>
        generateSingleImage(apiKey, request, taskId, index, abortController.signal)
      )
    );

    // 汇总结果
    const images = [];
    const errors = [];
    let sseResponses = 0;
    for (const result of itemResults) {
      if (result.status === 'fulfilled' && result.value.success) {
        images.push(...result.value.images);
        if (result.value.usesSse) sseResponses++;
      } else {
        const msg = result.status === 'fulfilled'
          ? result.value.error
          : normalizeError(result.reason);
        errors.push(msg);
        if (result.status === 'fulfilled' && result.value.usesSse) sseResponses++;
      }
    }
    const sse = sseResponses > 0 ? { responses: sseResponses, requests: request.parallelCount } : undefined;

    const completedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
    if (cancelledTaskIds.has(taskId)) {
      deleteTaskImageFiles(taskId);
      db.prepare(`
        UPDATE tasks SET status = 'failed', result_json = ?, error = ?, warning = NULL, completed_at = ?, expires_at = ? WHERE id = ?
      `).run(JSON.stringify({ images: [], ...(sse ? { sse } : {}) }), TASK_CANCELLED_ERROR, completedAt, new Date(Date.now() + ACK_GRACE_MS).toISOString(), taskId);
      db.prepare(`
        UPDATE task_items
        SET status = 'failed', error = ?, completed_at = COALESCE(completed_at, ?)
        WHERE task_id = ? AND status != 'failed'
      `).run(TASK_CANCELLED_ERROR, completedAt, taskId);
    } else if (images.length > 0) {
      const warning = errors.length > 0 ? `${errors.length} 张图片生成失败: ${errors.join('; ')}` : null;
      db.prepare(`
        UPDATE tasks SET status = 'completed', result_json = ?, warning = ?, completed_at = ?, expires_at = ? WHERE id = ?
      `).run(JSON.stringify({ images, ...(sse ? { sse } : {}) }), warning, completedAt, expiresAt, taskId);
    } else {
      db.prepare(`
        UPDATE tasks SET status = 'failed', result_json = ?, error = ?, completed_at = ?, expires_at = ? WHERE id = ?
      `).run(JSON.stringify({ images: [], ...(sse ? { sse } : {}) }), `所有图片生成失败: ${errors.join('; ')}`, completedAt, expiresAt, taskId);
    }
    broadcastTask(taskId);
  } catch (error) {
    const completedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
    try {
      db.prepare(`
        UPDATE tasks
        SET status = 'failed', result_json = ?, error = ?, completed_at = ?, expires_at = ?
        WHERE id = ?
      `).run(JSON.stringify({ images: [] }), `任务执行异常: ${normalizeError(error)}`, completedAt, expiresAt, taskId);
    } catch (dbError) {
      console.error(`[task] failed to persist task failure: taskId=${taskId}`, dbError?.message || dbError);
    }
    broadcastTask(taskId);
  } finally {
    if (taskAbortControllers.get(taskId) === abortController) {
      taskAbortControllers.delete(taskId);
    }
    cancelledTaskIds.delete(taskId);
    cleanupTaskRuntimeState(taskId);
    broadcastQueueStatus();
  }
}

function appendTaskReadTokenToImageRef(ref, readToken) {
  if (!readToken || typeof ref !== 'string' || !ref.startsWith('URL:/api/flyreq/images/')) return ref;
  const rawUrl = ref.slice(4);
  const separator = rawUrl.includes('?') ? '&' : '?';
  return `URL:${rawUrl}${separator}token=${encodeURIComponent(readToken)}`;
}

function appendTaskReadTokenToResult(result, readToken) {
  if (!result || !readToken || !Array.isArray(result.images)) return result;
  return {
    ...result,
    images: result.images.map(ref => appendTaskReadTokenToImageRef(ref, readToken)),
  };
}

function serializeTask(task, readToken) {
  if (!task) return null;
  if (task.expires_at && Date.parse(task.expires_at) <= Date.now()) {
    return { id: task.id, status: 'expired', error: '该任务已超出取回时间' };
  }
  const result = appendTaskReadTokenToResult(task.result_json ? JSON.parse(task.result_json) : undefined, readToken);
  return {
    id: task.id,
    status: task.status,
    mode: task.mode,
    result,
    error: task.error,
    warning: task.warning,
    createdAt: task.created_at,
    completedAt: task.completed_at,
    expiresAt: task.expires_at,
  };
}

function removeQueuedTask(taskId) {
  let removed = false;
  for (let index = queue.length - 1; index >= 0; index--) {
    if (queue[index] !== taskId) continue;
    queue.splice(index, 1);
    removed = true;
  }
  return removed;
}

function cancelTask(taskId) {
  const task = db.prepare('SELECT id, status, expires_at FROM tasks WHERE id = ?').get(taskId);
  if (!task) {
    throw createHttpError(404, 'TASK_NOT_FOUND', '任务不存在或已清理');
  }
  if (task.expires_at && Date.parse(task.expires_at) <= Date.now()) {
    throw createHttpError(404, 'TASK_EXPIRED', '任务已过期');
  }
  if ([TASK_STATUS.COMPLETED, TASK_STATUS.FAILED].includes(task.status)) {
    db.prepare('UPDATE tasks SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() + ACK_GRACE_MS).toISOString(), taskId
    );
    return { ok: true, cancelled: false, status: task.status };
  }

  const removedFromQueue = removeQueuedTask(taskId);
  const abortController = taskAbortControllers.get(taskId);
  cancelledTaskIds.add(taskId);
  if (abortController && !abortController.signal.aborted) {
    abortController.abort(new Error(TASK_CANCELLED_ERROR));
  }

  const completedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ACK_GRACE_MS).toISOString();
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE task_items
      SET status = 'failed', error = ?, completed_at = COALESCE(completed_at, ?)
      WHERE task_id = ? AND status IN (?, ?, ?)
    `).run(TASK_CANCELLED_ERROR, completedAt, taskId, TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED, TASK_STATUS.PROCESSING);
    db.prepare(`
      UPDATE tasks
      SET status = 'failed', result_json = ?, error = ?, warning = NULL, completed_at = ?, expires_at = ?
      WHERE id = ?
    `).run(JSON.stringify({ images: [] }), TASK_CANCELLED_ERROR, completedAt, expiresAt, taskId);
  });
  tx();

  if (removedFromQueue || !abortController) {
    cleanupTaskRuntimeState(taskId);
    cancelledTaskIds.delete(taskId);
  } else {
    cleanupTaskRuntimeState(taskId);
  }
  broadcastTask(taskId);
  broadcastQueueStatus();
  return { ok: true, cancelled: true, status: TASK_STATUS.FAILED };
}

function deleteTask(taskId) {
  const imageCleanup = deleteTaskImageFiles(taskId);
  if (imageCleanup.failed > 0) {
    throw new Error(`任务图片清理失败: ${imageCleanup.failed}/${imageCleanup.total}`);
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM task_items WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  });
  tx();
  cleanupTaskRuntimeState(taskId);
  broadcastQueueStatus();
}

function checkHealth() {
  const row = db.prepare('SELECT 1 AS ok').get();
  fs.accessSync(IMAGE_DIR, fs.constants.R_OK | fs.constants.W_OK);
  return {
    ok: row?.ok === 1,
    database: 'ok',
    imageDir: IMAGE_DIR,
    time: new Date().toISOString(),
  };
}

function cleanupExpiredTasks() {
  const ids = db.prepare('SELECT id FROM tasks WHERE expires_at IS NOT NULL AND expires_at <= ?').all(new Date().toISOString());
  let successCount = 0;
  let failCount = 0;
  for (const row of ids) {
    broadcastTaskExpired(row.id);
    try {
      deleteTask(row.id);
      successCount++;
    } catch (error) {
      failCount++;
      console.warn(`[cleanup] 过期任务删除失败: taskId=${row.id}`, error?.message || error);
    }
  }
  if (ids.length > 0) {
    console.log(`[cleanup] 本轮过期清理: 检查${ids.length}个任务, 成功${successCount}个, 失败${failCount}个`);
  }
}

// ===== WebSocket broadcasting =====

function safeSendJson(ws, payload) {
  try {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
  } catch (error) {
    console.warn('[ws] send failed', error?.message || error);
  }
}

function broadcastTask(taskId) {
  if (!taskId) return;
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  for (const [ws, subscriptions] of taskSubscriptions) {
    if (!subscriptions.has(taskId)) continue;
    const readToken = subscriptions.get(taskId);
    const task = serializeTask(row, readToken) || { id: taskId, status: 'expired', error: '该任务已超出取回时间' };
    safeSendJson(ws, { type: 'task', task });
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'expired') {
      subscriptions.delete(taskId);
    }
  }
}

function broadcastTaskExpired(taskId) {
  const payload = { type: 'task', task: { id: taskId, status: 'expired', error: '该任务已超出取回时间' } };
  for (const [ws, subscriptions] of taskSubscriptions) {
    if (!subscriptions.has(taskId)) continue;
    safeSendJson(ws, payload);
    subscriptions.delete(taskId);
  }
}

function flushQueueBroadcast() {
  queueBroadcastTimer = null;
  if (!queueBroadcastPending) return;
  queueBroadcastPending = false;
  if (queueSubscribers.size === 0) return;
  const stats = getQueueStats();
  const payload = { type: 'queueStatus', stats };
  for (const ws of queueSubscribers) {
    safeSendJson(ws, payload);
  }
}

function broadcastQueueStatus() {
  queueBroadcastPending = true;
  if (queueBroadcastTimer) return;
  queueBroadcastTimer = setTimeout(flushQueueBroadcast, 200);
}

function normalizeTaskSubscriptions(rawTasks) {
  if (!Array.isArray(rawTasks)) return [];
  return rawTasks
    .slice(0, WS_MAX_TASK_IDS_PER_MESSAGE)
    .map(item => {
      if (typeof item === 'string') return { id: item, readToken: '' };
      if (!item || typeof item !== 'object') return null;
      const id = typeof item.id === 'string' ? item.id : typeof item.taskId === 'string' ? item.taskId : '';
      const readToken = typeof item.readToken === 'string' ? item.readToken : typeof item.token === 'string' ? item.token : '';
      return { id, readToken };
    })
    .filter(Boolean);
}

function handleSubscribeTasks(ws, taskIds) {
  const requested = normalizeTaskSubscriptions(taskIds);
  if (requested.length === 0) return;
  let subscriptions = taskSubscriptions.get(ws);
  if (!subscriptions) {
    subscriptions = new Map();
    taskSubscriptions.set(ws, subscriptions);
  }
  for (const { id, readToken } of requested) {
    // 已达单连接订阅上限且是新 id 时停止，避免无限增长。
    if (!subscriptions.has(id) && subscriptions.size >= WS_MAX_SUBSCRIPTIONS_PER_SOCKET) break;
    if (!verifyTaskReadToken(id, readToken)) {
      safeSendJson(ws, { type: 'error', code: 'INVALID_TASK_TOKEN', message: '任务读取凭证无效' });
      continue;
    }
    subscriptions.set(id, readToken);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    const task = serializeTask(row, readToken) || { id, status: 'expired', error: '该任务已超出取回时间' };
    safeSendJson(ws, { type: 'task', task });
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'expired') {
      subscriptions.delete(id);
    }
  }
}

function handleUnsubscribeTasks(ws, taskIds) {
  const subscriptions = taskSubscriptions.get(ws);
  if (!subscriptions || !Array.isArray(taskIds)) return;
  for (const item of taskIds) {
    const id = typeof item === 'string'
      ? item
      : item && typeof item === 'object' && typeof item.id === 'string'
        ? item.id
        : '';
    if (id) subscriptions.delete(id);
  }
}

function handleSubscribeQueue(ws) {
  queueSubscribers.add(ws);
  safeSendJson(ws, { type: 'queueStatus', stats: getQueueStats() });
}

function handleClientMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    safeSendJson(ws, { type: 'error', code: 'INVALID_JSON', message: '消息不是合法 JSON' });
    return;
  }
  if (!msg || typeof msg.type !== 'string') {
    safeSendJson(ws, { type: 'error', code: 'INVALID_TYPE', message: '消息缺少 type' });
    return;
  }
  switch (msg.type) {
    case 'subscribeTasks':
      handleSubscribeTasks(ws, msg.tasks);
      if (!Array.isArray(msg.tasks) && Array.isArray(msg.taskIds)) {
        handleSubscribeTasks(ws, msg.taskIds);
      }
      break;
    case 'unsubscribeTasks':
      handleUnsubscribeTasks(ws, msg.tasks || msg.taskIds);
      break;
    case 'subscribeQueue':
      handleSubscribeQueue(ws);
      break;
    case 'unsubscribeQueue':
      queueSubscribers.delete(ws);
      break;
    case 'ping':
      safeSendJson(ws, { type: 'pong' });
      break;
    default:
      safeSendJson(ws, { type: 'error', code: 'UNKNOWN_TYPE', message: `未知的 type: ${msg.type}` });
  }
}

function setupWebSocketServer() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', ws => {
    wsAlive.set(ws, { lastPong: Date.now(), missed: 0 });

    ws.on('message', data => {
      handleClientMessage(ws, data.toString());
    });

    ws.on('pong', () => {
      const state = wsAlive.get(ws);
      if (state) {
        state.lastPong = Date.now();
        state.missed = 0;
      }
    });

    ws.on('close', () => {
      taskSubscriptions.delete(ws);
      queueSubscribers.delete(ws);
      wsAlive.delete(ws);
    });

    ws.on('error', error => {
      console.warn('[ws] connection error', error?.message || error);
    });
  });

  setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      const state = wsAlive.get(ws);
      if (!state) continue;
      if (Date.now() - state.lastPong > WS_HEARTBEAT_INTERVAL_MS + WS_PONG_GRACE_MS) {
        state.missed += 1;
        if (state.missed >= 2) {
          try { ws.terminate(); } catch { /* ignore */ }
          continue;
        }
      }
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, WS_HEARTBEAT_INTERVAL_MS).unref();

  return wss;
}

async function handleApi(req, res, parsedUrl) {
  try {
    const apiPathname = parsedUrl.pathname.replace(/\/+$/, '');

    if (req.method === 'GET' && apiPathname === '/api/flyreq/health') {
      try {
        sendJson(res, 200, checkHealth());
      } catch (error) {
        sendJson(res, 503, { ok: false, error: normalizeError(error) });
      }
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/flyreq/queue-status') {
      sendJson(res, 200, getQueueStats());
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/flyreq/prompts') {
      if (!authorizePromptGalleryDataRequest(req)) {
        sendPromptGalleryAccessDenied(res);
        return true;
      }
      const promptsPath = path.join(__dirname, 'prompts.json');
      try {
        if (!fs.existsSync(promptsPath)) {
          sendJson(res, 200, []);
          return true;
        }
        const raw = fs.readFileSync(promptsPath, 'utf8');
        const data = JSON.parse(raw);
        sendJson(res, 200, Array.isArray(data) ? data : []);
      } catch {
        sendJson(res, 200, []);
      }
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/flyreq/blacklist') {
      if (!authorizePromptGalleryDataRequest(req)) {
        sendPromptGalleryAccessDenied(res);
        return true;
      }
      const blacklistPath = path.join(__dirname, 'blacklist.json');
      try {
        if (!fs.existsSync(blacklistPath)) {
          sendJson(res, 200, { keywords: [] });
          return true;
        }
        const raw = fs.readFileSync(blacklistPath, 'utf8');
        const data = JSON.parse(raw);
        sendJson(res, 200, { keywords: Array.isArray(data.keywords) ? data.keywords : [] });
      } catch {
        sendJson(res, 200, { keywords: [] });
      }
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/flyreq/manifest.webmanifest') {
      sendJson(res, 200, buildPlatformManifest(resolvePlatformBranding(getRuntimeEnv())), {
        'Content-Type': 'application/manifest+json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/flyreq/config') {
      const env = getRuntimeEnv();
      const mode = resolvePromptGalleryMode(env);
      sendJson(
        res,
        200,
        {
          promptGalleryMode: mode,
          promptGalleryPasswordEnabled: String(env.PROMPT_GALLERY_PASSWORD || '').trim().length > 0,
          imageModelKeyGuide: resolveImageModelKeyGuide(env),
          imagePresetModelIds: resolveImagePresetModelIds(env),
          defaultImageModel: resolveDefaultImageModelConfig(env),
          branding: resolvePlatformBranding(env),
        },
        {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      );
      return true;
    }

    if (req.method === 'POST' && apiPathname === '/api/flyreq/prompt-gallery/verify') {
      const env = getRuntimeEnv();
      if (resolvePromptGalleryMode(env) === '3') {
        sendJson(res, 403, { ok: false, error: '提示词广场已关闭', code: 'PROMPT_GALLERY_DISABLED' });
        return true;
      }
      const expected = String(env.PROMPT_GALLERY_PASSWORD || '').trim();
      if (!expected) {
        sendJson(res, 200, { ok: true });
        return true;
      }

      enforceScopedApiRateLimit(req, { scope: 'prompt-gallery-verify', includeApiKey: false });
      const body = await readJsonBody(req, { maxBytes: SMALL_JSON_BODY_BYTES });
      const password = String(body?.password || '');
      const ok = verifyPromptGalleryPassword(password, expected);
      if (!ok) {
        sendJson(res, 200, { ok });
        return true;
      }
      const token = issuePromptGalleryAccessToken(expected);
      sendJson(res, 200, { ok, token }, { 'Set-Cookie': buildPromptGalleryAccessCookie(token) });
      return true;
    }

    const imageMatch = apiPathname.match(/^\/api\/flyreq\/images\/([^/]+)\/(\d+)(?:\/(\d+))?$/);
    if (req.method === 'GET' && imageMatch) {
      const taskId = imageMatch[1];
      const index = Number(imageMatch[2]);
      const hasSubIndex = imageMatch[3] !== undefined;
      const subIndex = hasSubIndex ? Number(imageMatch[3]) : 0;
      if (!/^[a-zA-Z0-9-]+$/.test(taskId)) {
        sendJson(res, 400, { error: 'Invalid taskId' });
        return true;
      }
      try {
        const taskForImage = db.prepare('SELECT id, expires_at FROM tasks WHERE id = ?').get(taskId);
        if (!taskForImage || (taskForImage.expires_at && Date.parse(taskForImage.expires_at) <= Date.now())) {
          sendJson(res, 404, { error: 'Not Found' });
          return true;
        }
        if (!verifyTaskReadToken(taskId, parsedUrl.searchParams.get('token') || getRequestReadToken(req))) {
          sendInvalidTaskReadToken(res);
          return true;
        }
        if (!fs.existsSync(IMAGE_DIR)) {
          sendJson(res, 404, { error: 'Not Found' });
          return true;
        }
        // 常见情况：扩展名 png/jpg/webp，直接拼路径命中，
        // 避免对整个 IMAGE_DIR 做同步 readdir 全目录扫描（随图片数线性变慢）。
        let filePath = null;
        for (const ext of ['png', 'jpg', 'webp']) {
          const candidate = path.join(IMAGE_DIR, `${taskId}-${index}-${subIndex}.${ext}`);
          if (fs.existsSync(candidate)) { filePath = candidate; break; }
        }
        // 旧任务地址不含 subIndex 时保留首个子图兼容回退；新地址必须精确命中。
        if (!filePath && !hasSubIndex) {
          const prefix = `${taskId}-${index}-`;
          const files = fs.readdirSync(IMAGE_DIR)
            .filter(name => name.startsWith(prefix))
            .sort();
          if (files.length > 0) filePath = path.join(IMAGE_DIR, files[0]);
        }
        if (!filePath) {
          sendJson(res, 404, { error: 'Not Found' });
          return true;
        }
        const stat = fs.statSync(filePath);
        pipeFileToResponse(res, filePath, 200, {
          'Content-Type': getContentType(filePath),
          'Content-Length': stat.size,
          'Cache-Control': 'private, max-age=3600',
        });
      } catch {
        sendJson(res, 404, { error: 'Not Found' });
      }
      return true;
    }

    // ===== 文本 AI 代理（流式 + 非流式，OpenAI / Google 协议） =====
    if (req.method === 'POST' && apiPathname === '/api/flyreq/proxy/text') {
      let proxyAbort = null;
      try {
        const body = await readJsonBody(req, { maxBytes: TEXT_PROXY_REQUEST_BODY_BYTES });
        const protocol = validateProxyProtocol(body?.protocol);
        const { baseUrl, apiKey, model, stream, requestBody } = body;
        if (!apiKey) {
          sendJson(res, 400, { error: '缺少 API 密钥' });
          return true;
        }
        if (protocol === 'google' && (typeof model !== 'string' || model.trim().length === 0)) {
          sendJson(res, 400, { error: '模型名称不能为空' });
          return true;
        }
        if (requestBody !== undefined && (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody))) {
          sendJson(res, 400, { error: '请求体不能为空' });
          return true;
        }

        enforceScopedApiRateLimit(req, { scope: 'proxy-text', apiKey });
        const fixedBaseUrl = resolveFixedRkapiGatewayBaseUrl(protocol, baseUrl);
        const normalizedBaseUrl = resolveAndLogOutboundBaseUrl('文本代理', protocol, fixedBaseUrl).baseUrl;
        let targetUrl;
        const authHeaders = { 'Content-Type': 'application/json' };

        if (protocol === 'google') {
          targetUrl = appendProtocolApiPath(
            'google',
            normalizedBaseUrl,
            stream
              ? `/v1beta/models/${encodeURIComponent(model || '')}:streamGenerateContent?alt=sse`
              : `/v1beta/models/${encodeURIComponent(model || '')}:generateContent`,
          );
          authHeaders['x-goog-api-key'] = apiKey;
          authHeaders['Authorization'] = `Bearer ${apiKey}`;
        } else {
          targetUrl = appendProtocolApiPath('openai', normalizedBaseUrl, '/v1/responses');
          authHeaders['Authorization'] = `Bearer ${apiKey}`;
        }

        if (stream) {
          authHeaders['Accept'] = 'text/event-stream';
        }

        let forwardedBody;
        if (requestBody) {
          forwardedBody = requestBody;
        } else {
          const clean = { ...body };
          delete clean.protocol;
          delete clean.baseUrl;
          delete clean.apiKey;
          delete clean.model;
          delete clean.stream;
          delete clean.requestBody;
          forwardedBody = clean;
        }

        proxyAbort = createRequestAbortSignal(req, res);
        const upstream = await fetchWithTimeout(targetUrl, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(forwardedBody),
          signal: proxyAbort.signal,
        });

        if (stream && upstream.ok) {
          res.writeHead(upstream.status, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          const reader = upstream.body.getReader();
          const cancelReader = () => {
            void reader.cancel().catch(() => undefined);
          };
          proxyAbort.signal.addEventListener('abort', cancelReader, { once: true });
          try {
            while (true) {
              if (proxyAbort.signal.aborted) {
                await reader.cancel();
                return true;
              }
              const { done, value } = await reader.read();
              if (proxyAbort.signal.aborted) {
                await reader.cancel();
                return true;
              }
              if (done) { res.end(); return true; }
              res.write(value);
            }
          } catch {
            if (!res.writableEnded) res.end();
          } finally {
            proxyAbort.signal.removeEventListener('abort', cancelReader);
          }
          return true;
        }

        let data = null;
        try { data = await upstream.json(); } catch { /* ignore */ }
        sendJson(res, upstream.status, data || { error: `上游返回 ${upstream.status}` });
      } catch (error) {
        if (proxyAbort?.signal.aborted) {
          if (!res.writableEnded) res.end();
        } else if (error && error.message && /abort|timeout/i.test(error.message)) {
          sendJson(res, 504, { error: '代理请求上游超时' });
        } else if (isHttpError(error) && error.code === 'INVALID_PROTOCOL') {
          sendJson(res, 400, { error: '协议类型无效，必须为 google 或 openai' });
        } else if (isHttpError(error)) {
          sendHttpError(res, error);
        } else {
          sendJson(res, 502, { error: normalizeError(error) });
        }
      } finally {
        if (proxyAbort) proxyAbort.cleanup();
      }
      return true;
    }

    // ===== 模型检查代理（统一使用 /v1/models） =====
    if (req.method === 'POST' && apiPathname === '/api/flyreq/proxy/models') {
      try {
        const body = await readJsonBody(req, { maxBytes: SMALL_JSON_BODY_BYTES });
        const apiKey = String(body?.apiKey || '');
        const protocol = validateProxyProtocol(body?.protocol);
        const baseUrl = resolveFixedRkapiGatewayBaseUrl(protocol, body?.baseUrl);
        const modelId = String(body?.modelId || '').trim();
        if (!apiKey) {
          sendJson(res, 400, { error: '缺少 API 密钥' });
          return true;
        }
        if (protocol === 'google' && !modelId) {
          sendJson(res, 400, { error: '模型名称不能为空' });
          return true;
        }

        enforceScopedApiRateLimit(req, { scope: 'proxy-models', apiKey });
        const normalizedBaseUrl = resolveAndLogOutboundBaseUrl('模型列表', protocol, baseUrl).baseUrl;
        let modelsUrl;
        let headers;
        if (protocol === 'google' && modelId) {
          modelsUrl = appendProtocolApiPath('google', normalizedBaseUrl, `/v1beta/models/${encodeURIComponent(modelId)}`);
          headers = {
            'x-goog-api-key': apiKey,
            Authorization: `Bearer ${apiKey}`,
          };
        } else {
          modelsUrl = appendProtocolApiPath('openai', normalizedBaseUrl, '/v1/models');
          headers = { Authorization: `Bearer ${apiKey}` };
        }

        const response = await fetchWithTimeout(modelsUrl, { method: 'GET', headers });
        let data = null;
        try { data = await response.json(); } catch { /* ignore */ }
        sendJson(res, response.status, data);
      } catch (error) {
        if (isHttpError(error) && error.code === 'INVALID_PROTOCOL') {
          sendJson(res, 400, { error: '协议类型无效，必须为 google 或 openai' });
        } else if (isHttpError(error)) {
          sendHttpError(res, error);
        } else {
          sendJson(res, 502, { error: normalizeError(error) });
        }
      }
      return true;
    }

    // 批量创建端点：请求体包含公共参数和 parallelCount，响应按图片序号返回独立 taskIds。
    if (req.method === 'POST' && apiPathname === '/api/flyreq/tasks/batch') {
      const body = await readJsonBody(req, { maxBytes: TASK_REQUEST_BODY_BYTES });
      const tasks = createTaskBatch(body, req);
      sendJson(res, 202, { tasks, taskIds: tasks.map(task => task.taskId) });
      return true;
    }

    if (req.method === 'POST' && apiPathname === '/api/flyreq/tasks') {
      const body = await readJsonBody(req, { maxBytes: TASK_REQUEST_BODY_BYTES });
      sendJson(res, 202, createTask(body, req));
      return true;
    }

    const match = apiPathname.match(/^\/api\/flyreq\/tasks\/([^/]+)(?:\/(ack|cancel))?$/);
    if (!match) return false;
    const taskId = decodeURIComponent(match[1]);
    const action = match[2];

    if (req.method === 'GET' && !action) {
      const taskReadToken = getRequestReadToken(req) || parsedUrl.searchParams.get('token') || '';
      if (!verifyTaskReadToken(taskId, getRequestReadToken(req) || parsedUrl.searchParams.get('token'))) {
        sendInvalidTaskReadToken(res);
        return true;
      }
      const task = serializeTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId), taskReadToken);
      sendJson(res, task ? 200 : 404, task || { id: taskId, status: 'expired', error: '该任务已超出取回时间' });
      return true;
    }

    if (req.method === 'POST' && action === 'ack') {
      if (!verifyTaskReadToken(taskId, getRequestReadToken(req) || parsedUrl.searchParams.get('token'))) {
        sendInvalidTaskReadToken(res);
        return true;
      }
      const taskForAck = db.prepare('SELECT id, status, expires_at FROM tasks WHERE id = ?').get(taskId);
      if (!taskForAck) {
        sendJson(res, 404, { error: '任务不存在或已清理', code: 'TASK_NOT_FOUND' });
        return true;
      }
      if (taskForAck.expires_at && Date.parse(taskForAck.expires_at) <= Date.now()) {
        sendJson(res, 404, { error: '任务已过期', code: 'TASK_EXPIRED' });
        return true;
      }
      if (!['completed', 'failed'].includes(taskForAck.status)) {
        sendJson(res, 409, { error: '任务尚未结束，暂不能 ack', code: 'TASK_NOT_TERMINAL' });
        return true;
      }
      db.prepare('UPDATE tasks SET expires_at = ? WHERE id = ?').run(
        new Date(Date.now() + ACK_GRACE_MS).toISOString(), taskId
      );
      sendJson(res, 200, { ok: true, acknowledged: true });
      return true;
    }

    if (req.method === 'POST' && action === 'cancel') {
      if (!verifyTaskReadToken(taskId, getRequestReadToken(req) || parsedUrl.searchParams.get('token'))) {
        sendInvalidTaskReadToken(res);
        return true;
      }
      sendJson(res, 200, cancelTask(taskId));
      return true;
    }

    sendJson(res, 405, { error: 'Method Not Allowed' });
    return true;
  } catch (error) {
    if (isHttpError(error)) {
      sendHttpError(res, error);
    } else if (error && typeof error.statusCode === 'number') {
      sendJson(res, error.statusCode, { error: normalizeError(error) });
    } else {
      sendJson(res, 400, { error: normalizeError(error) });
    }
    return true;
  }
}

initDatabase();
ensureImageDir();
logBaseUrlRewriteConfiguration();
cleanupExpiredTasks();
setInterval(cleanupExpiredTasks, CLEANUP_INTERVAL_MS).unref();
setInterval(cleanupRateLimitBuckets, CLEANUP_INTERVAL_MS).unref();

const startServer = () => {
  const wss = setupWebSocketServer();
  const httpServer = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || `${HOSTNAME}:${PORT}`}`);
    if (parsedUrl.pathname?.startsWith('/api/flyreq/')) {
      const handled = await handleApi(req, res, parsedUrl);
      if (handled || res.headersSent || res.writableEnded) return;
    }
    if (!IS_DEV) {
      if (serveStatic(req, res, parsedUrl.pathname || '/')) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    handle(req, res, req.url || '/');
  });

  const nextUpgradeHandler = IS_DEV && typeof app.getUpgradeHandler === 'function'
    ? app.getUpgradeHandler()
    : null;

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url || '/', `http://${req.headers.host || `${HOSTNAME}:${PORT}`}`).pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === '/api/flyreq/ws') {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
      return;
    }
    if (nextUpgradeHandler) {
      nextUpgradeHandler(req, socket, head);
      return;
    }
    socket.destroy();
  });

  httpServer.listen(PORT, HOSTNAME, () => {
    const localUrl = `http://localhost:${PORT}`;
    const listenUrl = `http://${HOSTNAME}:${PORT}`;
    console.log(`RKAPI Image server ready on ${localUrl}`);
    if (HOSTNAME !== 'localhost' && HOSTNAME !== '127.0.0.1') {
      console.log(`Listening on ${listenUrl}`);
    }
  });
};

if (IS_DEV) {
  app.prepare().then(startServer);
} else {
  startServer();
}

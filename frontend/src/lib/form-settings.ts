/**
 * 文本生图 / 图生图 共享的表单设置类型
 * 两个表单（TextToImageForm、ImageToImageForm）的设置字段完全一致，
 * 统一定义于此避免重复。
 */

import type { ModelId } from '@/lib/gemini-config';
import type { OutputSize, AspectRatio } from '@/lib/job-store';
import type { GptImageBackground, GptImageOutputFormat, GptImageQuality, GptImageStyle, ParallelCount } from '@/lib/model-capabilities';
import {
  getCompleteImageModels,
  loadRegistry,
  RKAPI_DEFAULT_IMAGE_4K_ID,
  RKAPI_DEFAULT_IMAGE_REVERSE_ID,
  saveRegistry,
} from '@/lib/flyreq-models';

export interface ImageFormSettings {
  model: ModelId;
  outputSize: OutputSize;
  customSize?: string;
  aspectRatio: AspectRatio;
  temperature: number;
  gptImageQuality: GptImageQuality;
  gptImageStyle: GptImageStyle;
  gptImageBackground: GptImageBackground;
  gptImageOutputFormat: GptImageOutputFormat;
  parallelCount: ParallelCount;
  promptVariants?: string[];
}

export const IMAGE_FORM_SETTINGS_STORAGE_KEYS = [
  'flyreq-image-generation-settings',
  'flyreq-t2i-settings',
  'flyreq-i2i-settings',
] as const;

export interface ImageModelFormDefaults {
  textToImage: ModelId;
  imageToImage: ModelId;
}

const RKAPI_IMAGE_DEFAULTS_MIGRATION_KEY = 'rkapi-image-form-defaults-migrated-v1';
const SHARED_IMAGE_SETTINGS_KEY = 'flyreq-image-generation-settings';
const T2I_SETTINGS_KEY = 'flyreq-t2i-settings';
const I2I_SETTINGS_KEY = 'flyreq-i2i-settings';

function getBrowserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  const storage = window.localStorage;
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    ? storage
    : null;
}

function updateStoredModel(storage: Storage, key: string, updater: (modelId: unknown) => ModelId | unknown): void {
  try {
    const raw = storage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    const existing = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const nextModel = updater((existing as { model?: unknown }).model);
    storage.setItem(key, JSON.stringify({ ...existing, model: nextModel }));
  } catch {
    // 单个缓存项不可读或不可写时，不影响其余表单缓存恢复默认模型。
  }
}

function saveModelToFormSettings(key: string, modelId: ModelId): void {
  if (!modelId) return;
  const storage = getBrowserStorage();
  if (!storage) return;
  updateStoredModel(storage, key, () => modelId);
}

function migrateStoredModel(storage: Storage, key: string, fromModelId: ModelId, toModelId: ModelId): void {
  updateStoredModel(storage, key, (modelId) => (modelId === fromModelId ? toModelId : modelId));
}

/**
 * 将首次保存的图片模型写入所有生图表单的本地默认设置，同时保留其他表单参数。
 * @param modelId 首个配置完整的图片模型内部标识。
 * @returns 无返回值；存储不可用或单项缓存损坏时会继续处理其余表单缓存。
 */
export function saveImageModelFormDefaults(defaults: ImageModelFormDefaults): void {
  saveModelToFormSettings(SHARED_IMAGE_SETTINGS_KEY, defaults.textToImage);
  saveModelToFormSettings(T2I_SETTINGS_KEY, defaults.textToImage);
  saveModelToFormSettings(I2I_SETTINGS_KEY, defaults.imageToImage);
}

export function saveFirstImageModelAsFormDefault(modelId: ModelId): void {
  saveImageModelFormDefaults({ textToImage: modelId, imageToImage: modelId });
}

export function migrateRkapiImageFormDefaults(): void {
  const storage = getBrowserStorage();
  if (!storage) return;
  try {
    if (storage.getItem(RKAPI_IMAGE_DEFAULTS_MIGRATION_KEY)) return;
    const registry = loadRegistry();
    const hasRkapiPair = registry.imageModels.some((model) => model.id === RKAPI_DEFAULT_IMAGE_4K_ID)
      && registry.imageModels.some((model) => model.id === RKAPI_DEFAULT_IMAGE_REVERSE_ID);

    if (hasRkapiPair) {
      const defaults = { ...registry.defaults };
      let shouldSaveRegistry = false;
      if (!defaults.textToImage || defaults.textToImage === RKAPI_DEFAULT_IMAGE_REVERSE_ID) {
        defaults.textToImage = RKAPI_DEFAULT_IMAGE_4K_ID;
        shouldSaveRegistry = true;
      }
      if (!defaults.imageToImage || defaults.imageToImage === RKAPI_DEFAULT_IMAGE_4K_ID) {
        defaults.imageToImage = RKAPI_DEFAULT_IMAGE_REVERSE_ID;
        shouldSaveRegistry = true;
      }
      if (shouldSaveRegistry && getCompleteImageModels(registry).length > 0) {
        saveRegistry({ ...registry, defaults });
      }
      migrateStoredModel(storage, I2I_SETTINGS_KEY, RKAPI_DEFAULT_IMAGE_4K_ID, RKAPI_DEFAULT_IMAGE_REVERSE_ID);
    }

    storage.setItem(RKAPI_IMAGE_DEFAULTS_MIGRATION_KEY, '1');
  } catch {
    // 迁移失败不阻塞工作台，后续加载仍会使用注册表默认值兜底。
  }
}

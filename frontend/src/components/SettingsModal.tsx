'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  ImageIcon,
  Info,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { BackupProgress } from '@/components/BackupProgress';
import {
  BUILTIN_IMAGE_PRESETS,
  applyImageModelToDefaultTasks,
  applyBuiltinImagePresetModelIds,
  BUILTIN_IMAGE_PRESET_OPTIONS,
  DEFAULT_DEFAULTS,
  RKAPI_BASE_URL,
  RKAPI_DEFAULT_IMAGE_4K_ID,
  RKAPI_DEFAULT_IMAGE_REVERSE_ID,
  RKAPI_DEFAULT_TEXT_MODEL_ID,
  RKAPI_TEXT_MODEL_NAME,
  generateModelId,
  getDefaultTextModelTemplate,
  getCompleteImageModels,
  getImageModelOutputSizes,
  getRkapiImageModelName,
  getResolvedImageModelId,
  isXaiImaginePresetId,
  loadRegistry,
  saveRegistry,
  type DefaultModels,
  type ImageModelConfig,
  type ProviderProtocol,
  type TextModelConfig,
} from '@/lib/flyreq-models';
import { getExternalImageModelMatch, type ExternalModelConfig } from '@/lib/external-model-config';
import { syncDynamicModelExports } from '@/lib/gemini-config';
import { exportAllData, importAllData, downloadBlob, generateBackupFilename, type BackupProgress as BackupProgressType } from '@/lib/backup-utils';
import { checkModelsAvailability, type ModelStatus } from '@/lib/flyreq-task-client';
import { hasConfiguredImageModel, isPromptOptimizeEnabled, setPromptOptimizeEnabled } from '@/lib/settings-storage';
import { saveImageModelFormDefaults } from '@/lib/form-settings';
import {
  getEnabledTextModelsForSettingsSave,
  getPersistableTextModelsForSettingsSave,
  getSettingsModelSaveError,
} from '@/lib/settings-text-models';
import { IMAGE_MODEL_KEY_GUIDE } from '@/lib/constants';
import { getOutputSizeLabel } from '@/lib/model-capabilities';
import { useBranding } from '@/components/BrandProvider';

type ImageModelKeyGuide = typeof IMAGE_MODEL_KEY_GUIDE;

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApiKeyChange?: (hasKey: boolean) => void;
  externalModelConfig?: ExternalModelConfig | null;
  onExternalModelConfigConsumed?: () => void;
}

function cloneImageModel(model: ImageModelConfig): ImageModelConfig {
  return { ...model };
}

function cloneTextModel(model: TextModelConfig): TextModelConfig {
  return { ...model };
}

/**
 * 创建新增图片模型的默认草稿。
 * @returns 使用默认内置预设的未完成配置。
 */
function createImageModelDraft(): ImageModelConfig {
  const preset = BUILTIN_IMAGE_PRESETS['gpt-image-2'];
  const id = generateModelId('img');
  return {
    id,
    protocol: preset.protocol,
    name: getRkapiImageModelName(id),
    modelId: preset.modelId,
    apiKey: '',
    baseUrl: RKAPI_BASE_URL,
    builtinPreset: preset.id,
    maxRefImages: preset.maxRefImages,
    maxOutputSize: preset.maxOutputSize,
    supportsAdvancedParams: preset.supportsAdvancedParams,
    supportsTemperature: false,
    streamImages: true,
  };
}

function getExternalImagePresetId(config: ExternalModelConfig, fallback: ImageModelConfig['builtinPreset']) {
  if (config.preset) return config.preset;
  return isXaiImaginePresetId(config.modelId || '')
    ? config.modelId as ImageModelConfig['builtinPreset']
    : fallback;
}

function createExternalImageModelDraft(config: ExternalModelConfig): ImageModelConfig {
  const preset = BUILTIN_IMAGE_PRESETS[getExternalImagePresetId(config, 'gpt-image-2')];
  const isXaiImagine = isXaiImaginePresetId(preset.id);
  const protocol = isXaiImagine ? preset.protocol : (config.protocol || preset.protocol);
  const isGptImage = preset.id === 'gpt-image-2';
  const configuredModelId = config.modelId?.trim() || '';
  return {
    id: config.modelKey || generateModelId('img'),
    protocol,
    name: getRkapiImageModelName(config.modelKey || ''),
    modelId: configuredModelId || preset.modelId,
    apiKey: '',
    baseUrl: RKAPI_BASE_URL,
    builtinPreset: preset.id,
    maxRefImages: isXaiImagine ? preset.maxRefImages : (config.maxRefImages || preset.maxRefImages),
    maxOutputSize: isXaiImagine && config.maxOutputSize !== '1K' ? preset.maxOutputSize : (config.maxOutputSize || preset.maxOutputSize),
    supportsAdvancedParams: protocol === 'openai' && isGptImage ? preset.supportsAdvancedParams : false,
    supportsTemperature: protocol === 'google' && Boolean(config.supportsTemperature ?? preset.supportsTemperature),
    streamImages: protocol === 'openai' && isGptImage ? Boolean(config.streamImages ?? preset.streamImages) : false,
  };
}

function patchImageModelFromExternal(model: ImageModelConfig, config: ExternalModelConfig): ImageModelConfig {
  const preset = BUILTIN_IMAGE_PRESETS[getExternalImagePresetId(config, model.builtinPreset)];
  const isXaiImagine = isXaiImaginePresetId(preset.id);
  const protocol = isXaiImagine ? preset.protocol : (config.protocol || model.protocol || preset.protocol);
  const isGptImage = preset.id === 'gpt-image-2';
  const configuredModelId = config.modelId === undefined
    ? model.modelId.trim() || preset.modelId
    : config.modelId.trim();
  return {
    ...model,
    protocol,
    builtinPreset: preset.id,
    name: getRkapiImageModelName(model.id),
    modelId: configuredModelId || preset.modelId,
    baseUrl: RKAPI_BASE_URL,
    apiKey: model.apiKey,
    maxRefImages: isXaiImagine ? preset.maxRefImages : (config.maxRefImages || model.maxRefImages || preset.maxRefImages),
    maxOutputSize: isXaiImagine && config.maxOutputSize !== '1K'
      ? preset.maxOutputSize
      : (config.maxOutputSize || model.maxOutputSize || preset.maxOutputSize),
    supportsAdvancedParams: protocol === 'openai' && isGptImage ? model.supportsAdvancedParams || preset.supportsAdvancedParams : false,
    supportsTemperature: protocol === 'google' && Boolean(config.supportsTemperature ?? model.supportsTemperature ?? preset.supportsTemperature),
    streamImages: protocol === 'openai' && isGptImage ? Boolean(config.streamImages ?? model.streamImages ?? preset.streamImages) : false,
  };
}

function createTextModelDraft(): TextModelConfig {
  const template = getDefaultTextModelTemplate('openai');
  return {
    id: generateModelId('txt'),
    protocol: template.protocol,
    name: RKAPI_TEXT_MODEL_NAME,
    modelId: template.modelId,
    apiKey: '',
    baseUrl: RKAPI_BASE_URL,
    note: template.note,
  };
}

function isCompleteImageModel(model: ImageModelConfig): boolean {
  return Boolean(model.name.trim() && getResolvedImageModelId(model) && model.apiKey.trim() && model.baseUrl.trim());
}

function isCompleteTextModel(model: TextModelConfig): boolean {
  return Boolean(model.name.trim() && model.modelId.trim() && model.apiKey.trim() && model.baseUrl.trim());
}

function getImageModelLabel(models: ImageModelConfig[], id: string): string | undefined {
  return models.find((model) => model.id === id)?.name;
}

function getTextModelLabel(models: TextModelConfig[], id: string): string | undefined {
  return models.find((model) => model.id === id)?.name;
}

function normalizeDefaults(
  defaults: DefaultModels,
  imageModels: ImageModelConfig[],
  textModels: TextModelConfig[],
): DefaultModels {
  const completeImageModels = imageModels.filter(isCompleteImageModel);
  const completeTextModels = textModels.filter(isCompleteTextModel);
  const preferredTextToImageId = completeImageModels.some((model) => model.id === RKAPI_DEFAULT_IMAGE_4K_ID)
    ? RKAPI_DEFAULT_IMAGE_4K_ID
    : completeImageModels[0]?.id || '';
  const preferredImageToImageId = completeImageModels.some((model) => model.id === RKAPI_DEFAULT_IMAGE_REVERSE_ID)
    ? RKAPI_DEFAULT_IMAGE_REVERSE_ID
    : completeImageModels[0]?.id || '';
  const preferredTextModelId = completeTextModels.some((model) => model.id === RKAPI_DEFAULT_TEXT_MODEL_ID)
    ? RKAPI_DEFAULT_TEXT_MODEL_ID
    : completeTextModels[0]?.id || '';

  return {
    textToImage: completeImageModels.some((model) => model.id === defaults.textToImage) ? defaults.textToImage : preferredTextToImageId,
    imageToImage: completeImageModels.some((model) => model.id === defaults.imageToImage) ? defaults.imageToImage : preferredImageToImageId,
    reversePrompt: completeTextModels.some((model) => model.id === defaults.reversePrompt) ? defaults.reversePrompt : preferredTextModelId,
    agent: completeTextModels.some((model) => model.id === defaults.agent) ? defaults.agent : preferredTextModelId,
    promptOptimize: completeTextModels.some((model) => model.id === defaults.promptOptimize) ? defaults.promptOptimize : preferredTextModelId,
    imageDescribe: completeTextModels.some((model) => model.id === defaults.imageDescribe) ? defaults.imageDescribe : preferredTextModelId,
  };
}

export function SettingsModal({ isOpen, onClose, onApiKeyChange, externalModelConfig, onExternalModelConfigConsumed }: SettingsModalProps) {
  const { platformVersion } = useBranding();
  const [imageModels, setImageModels] = useState<ImageModelConfig[]>([]);
  const [textModels, setTextModels] = useState<TextModelConfig[]>([]);
  const [defaults, setDefaults] = useState<DefaultModels>(DEFAULT_DEFAULTS);
  const [selectedImageModelId, setSelectedImageModelId] = useState('');
  const [selectedTextModelId, setSelectedTextModelId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [externalConfigNotice, setExternalConfigNotice] = useState<string | null>(null);
  const [checkingModels, setCheckingModels] = useState(false);
  const [modelStatuses, setModelStatuses] = useState<ModelStatus[] | null>(null);
  const [modelCheckError, setModelCheckError] = useState<string | null>(null);
  const [showImageApiKey, setShowImageApiKey] = useState(false);
  const [showTextApiKey, setShowTextApiKey] = useState(false);
  const [promptOptimizeEnabled, setPromptOptimizeEnabledState] = useState(false);
  const [imageModelKeyGuide, setImageModelKeyGuide] = useState<ImageModelKeyGuide>(IMAGE_MODEL_KEY_GUIDE);

  const [backupProgress, setBackupProgress] = useState<BackupProgressType>({ percent: 0, message: '' });
  const [isBackupActive, setIsBackupActive] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupSuccess, setBackupSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const registry = loadRegistry();
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setImageModels(registry.imageModels.map(cloneImageModel));
      setTextModels(registry.textModels.map(cloneTextModel));
      setDefaults(normalizeDefaults(registry.defaults, registry.imageModels, registry.textModels));
      setSelectedImageModelId(registry.imageModels[0]?.id || '');
      setSelectedTextModelId(registry.textModels[0]?.id || '');
      setError(null);
      setSuccess(null);
      setExternalConfigNotice(null);
      setModelStatuses(null);
      setModelCheckError(null);
      setBackupError(null);
      setBackupSuccess(null);
      setPromptOptimizeEnabledState(isPromptOptimizeEnabled());
    });
    return () => { cancelled = true; };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    fetch('/api/flyreq/config', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: { imageModelKeyGuide?: Partial<ImageModelKeyGuide>; imagePresetModelIds?: Parameters<typeof applyBuiltinImagePresetModelIds>[0] }) => {
        if (cancelled) return;
        applyBuiltinImagePresetModelIds(data.imagePresetModelIds);
        const guide = data.imageModelKeyGuide || {};
        setImageModelKeyGuide({
          title: guide.title || IMAGE_MODEL_KEY_GUIDE.title,
          description: guide.description || IMAGE_MODEL_KEY_GUIDE.description,
          ctaLabel: guide.ctaLabel || IMAGE_MODEL_KEY_GUIDE.ctaLabel,
          url: guide.url || IMAGE_MODEL_KEY_GUIDE.url,
        });
      })
      .catch(() => {
        if (!cancelled) setImageModelKeyGuide(IMAGE_MODEL_KEY_GUIDE);
      });

    return () => { cancelled = true; };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !externalModelConfig) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setImageModels((prev) => {
        const existing = getExternalImageModelMatch(prev, externalModelConfig);
        const nextModel = existing
          ? patchImageModelFromExternal(existing, externalModelConfig)
          : createExternalImageModelDraft(externalModelConfig);
        setSelectedImageModelId(nextModel.id);
        setDefaults((current) => applyImageModelToDefaultTasks(current, nextModel.id));
        return existing
          ? prev.map((model) => (model.id === existing.id ? nextModel : model))
          : [...prev, nextModel];
      });
      setExternalConfigNotice('已从外部链接带入模型配置，请补充 API Key 后点击“保存设置”。URL 中的配置参数已清理。');
      setError(null);
      setSuccess(null);
      onExternalModelConfigConsumed?.();
    });
    return () => { cancelled = true; };
  }, [externalModelConfig, isOpen, onExternalModelConfigConsumed]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setDefaults((prev) => {
        const next = normalizeDefaults(prev, imageModels, textModels);
        return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
      });
    });
    return () => { cancelled = true; };
  }, [imageModels, isOpen, textModels]);

  const selectedImageModel = useMemo(
    () => imageModels.find((model) => model.id === selectedImageModelId) || null,
    [imageModels, selectedImageModelId],
  );
  const selectedTextModel = useMemo(
    () => textModels.find((model) => model.id === selectedTextModelId) || null,
    [selectedTextModelId, textModels],
  );

  const handleAddImageModel = () => {
    const draft = createImageModelDraft();
    setImageModels((prev) => [...prev, draft]);
    setSelectedImageModelId(draft.id);
  };

  /**
   * 更新指定图片模型，并同步模板所约束的默认参数。
   * @param id 待更新图片模型的内部标识。
   * @param patch 用户本次修改的字段集合。
   * @returns 无返回值；通过状态更新渲染最新配置。
   */
  const handleUpdateImageModel = (id: string, patch: Partial<ImageModelConfig>) => {
    setImageModels((prev) => prev.map((model) => {
      if (model.id !== id) return model;
      const next = { ...model, ...patch };
      if (patch.builtinPreset) {
        const preset = BUILTIN_IMAGE_PRESETS[patch.builtinPreset];
        next.protocol = preset.protocol;
        next.modelId = preset.modelId;
        next.usesPresetModelId = undefined;
        next.maxRefImages = preset.maxRefImages;
        next.maxOutputSize = preset.maxOutputSize;
        next.supportsAdvancedParams = preset.supportsAdvancedParams;
        next.supportsTemperature = preset.supportsTemperature;
        next.streamImages = preset.streamImages;
      }
      if ('modelId' in patch) {
        next.usesPresetModelId = undefined;
        if (next.protocol === 'google' && !next.usesPresetModelId) next.supportsTemperature = false;
      }
      if (isXaiImaginePresetId(next.builtinPreset)) {
        const preset = BUILTIN_IMAGE_PRESETS[next.builtinPreset];
        next.protocol = preset.protocol;
        next.maxRefImages = preset.maxRefImages;
        next.maxOutputSize = next.maxOutputSize === '1K' ? '1K' : preset.maxOutputSize;
        next.supportsAdvancedParams = false;
        next.supportsTemperature = false;
        next.streamImages = false;
      } else if (patch.protocol === 'google') {
        next.supportsAdvancedParams = false;
        next.streamImages = false;
        next.supportsTemperature = false;
      } else if (patch.protocol === 'openai') {
        next.supportsTemperature = false;
      }
      next.name = getRkapiImageModelName(next.id);
      next.baseUrl = RKAPI_BASE_URL;
      return next;
    }));
  };

  const handleDeleteImageModel = (id: string) => {
    const nextModels = imageModels.filter((model) => model.id !== id);
    setImageModels(nextModels);
    setDefaults((prev) => ({
      ...prev,
      textToImage: prev.textToImage === id ? '' : prev.textToImage,
      imageToImage: prev.imageToImage === id ? '' : prev.imageToImage,
    }));
    if (selectedImageModelId === id) {
      setSelectedImageModelId(nextModels[0]?.id || '');
    }
  };

  const handleAddTextModel = () => {
    const draft = createTextModelDraft();
    setTextModels((prev) => [...prev, draft]);
    setSelectedTextModelId(draft.id);
  };

  const handleApplyTextTemplate = (id: string, protocol: ProviderProtocol) => {
    const template = getDefaultTextModelTemplate(protocol);
    handleUpdateTextModel(id, {
      protocol: template.protocol,
      modelId: template.modelId,
      note: template.note,
    });
  };

  const handleUpdateTextModel = (id: string, patch: Partial<TextModelConfig>) => {
    setTextModels((prev) => prev.map((model) => (model.id === id ? {
      ...model,
      ...patch,
      name: RKAPI_TEXT_MODEL_NAME,
      baseUrl: RKAPI_BASE_URL,
    } : model)));
  };

  const handleDeleteTextModel = (id: string) => {
    const nextModels = textModels.filter((model) => model.id !== id);
    setTextModels(nextModels);
    setDefaults((prev) => ({
      ...prev,
      reversePrompt: prev.reversePrompt === id ? '' : prev.reversePrompt,
      agent: prev.agent === id ? '' : prev.agent,
      promptOptimize: prev.promptOptimize === id ? '' : prev.promptOptimize,
      imageDescribe: prev.imageDescribe === id ? '' : prev.imageDescribe,
    }));
    if (selectedTextModelId === id) {
      setSelectedTextModelId(nextModels[0]?.id || '');
    }
  };

  const persistRegistry = () => {
    const hasNoCompleteImageModelBeforeSave = getCompleteImageModels(loadRegistry()).length === 0;
    const persistableTextModels = getPersistableTextModelsForSettingsSave(textModels);
    const enabledTextModels = getEnabledTextModelsForSettingsSave(textModels);
    const saveError = getSettingsModelSaveError({
      imageModels,
      enabledTextModels,
      promptOptimizeEnabled,
    });
    if (saveError) {
      setError(saveError);
      return;
    }

    const registry = {
      imageModels,
      textModels: persistableTextModels,
      defaults: normalizeDefaults(defaults, imageModels, persistableTextModels),
    };

    saveRegistry(registry);
    if (hasNoCompleteImageModelBeforeSave && registry.defaults.textToImage) {
      saveImageModelFormDefaults({
        textToImage: registry.defaults.textToImage,
        imageToImage: registry.defaults.imageToImage,
      });
    }
    if (!setPromptOptimizeEnabled(promptOptimizeEnabled)) {
      setError('启用提示词优化前，请先完成至少一个文本模型配置');
      return;
    }
    syncDynamicModelExports();
    onApiKeyChange?.(hasConfiguredImageModel());
    setSuccess('设置已保存');
    setExternalConfigNotice(null);
    setError(null);
    setModelStatuses(null);
    setModelCheckError(null);
  };

  const handlePromptOptimizeToggle = (checked: boolean) => {
    if (checked && !textModels.some(isCompleteTextModel)) {
      setError('启用提示词优化前，请先完成至少一个文本模型配置');
      setPromptOptimizeEnabledState(false);
      return;
    }
    setPromptOptimizeEnabledState(checked);
    setError(null);
  };

  const handleCheckModels = async () => {
    const configuredModels = [
      ...imageModels.filter(isCompleteImageModel),
      ...textModels.filter(isCompleteTextModel),
    ];
    if (configuredModels.length === 0) {
      setModelCheckError('请先完成至少一个图片模型或文本模型配置');
      return;
    }

    setCheckingModels(true);
    setModelCheckError(null);
    setModelStatuses(null);
    try {
      const statuses = await checkModelsAvailability(configuredModels.map((model) => model.id), configuredModels.map((model) => ({
        id: model.id,
        name: model.name,
        protocol: model.protocol,
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        modelId: 'builtinPreset' in model ? getResolvedImageModelId(model) : model.modelId,
      })));
      setModelStatuses(statuses);
    } catch (err) {
      setModelCheckError(err instanceof Error ? err.message : '检查模型失败');
    } finally {
      setCheckingModels(false);
    }
  };

  const handleExport = async () => {
    setIsBackupActive(true);
    setBackupError(null);
    setBackupSuccess(null);
    try {
      const blob = await exportAllData((progress) => setBackupProgress(progress), platformVersion);
      const filename = generateBackupFilename();
      downloadBlob(blob, filename);
      setBackupSuccess(`数据已成功导出为 ${filename}`);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setIsBackupActive(false);
    }
  };

  const handleImport = async (file: File) => {
    if (!file.name.endsWith('.zip')) {
      setBackupError('请选择有效的备份文件（.zip 格式）');
      return;
    }

    setIsBackupActive(true);
    setBackupError(null);
    setBackupSuccess(null);
    try {
      await importAllData(file, (progress) => setBackupProgress(progress));
      setBackupSuccess('数据已成功导入，页面将在 2 秒后刷新。');
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : '导入失败');
      setIsBackupActive(false);
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) handleImport(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const completeImageOptions = imageModels.filter(isCompleteImageModel).map((model) => ({ value: model.id, label: model.name }));
  const completeTextOptions = textModels.filter(isCompleteTextModel).map((model) => ({ value: model.id, label: model.name }));
  const needsImageModelKeyGuide = !imageModels.some(isCompleteImageModel);
  const selectedImageOutputSizes: ImageModelConfig['maxOutputSize'][] = selectedImageModel
    ? getImageModelOutputSizes({
        ...selectedImageModel,
        maxOutputSize: BUILTIN_IMAGE_PRESETS[selectedImageModel.builtinPreset].maxOutputSize,
      })
    : ['1K'];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open && isBackupActive) return;
      if (!open) onClose();
    }}>
      <DialogContent className="flex max-h-[92vh] flex-col overflow-hidden p-0 pt-0 gap-0 sm:max-w-5xl">
        <DialogHeader className="p-4 pb-3">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-muted-foreground" />
            <DialogTitle>设置</DialogTitle>
          </div>
          <DialogDescription>按模型分别配置协议、URL 和 API Key。基础生图只需要图片模型；Agent、反推、提示词优化等智能文本功能才需要文本模型。</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="models" className="min-h-0 flex-1 gap-0">
          <TabsList className="w-full rounded-none border-b bg-transparent h-auto p-0">
            <TabsTrigger value="models" className="gap-2 rounded-none border-b-2 border-transparent data-active:border-primary data-active:bg-transparent data-active:shadow-none px-4 py-3">
              <ImageIcon className="w-4 h-4" />
              模型配置
            </TabsTrigger>
            <TabsTrigger value="backup" className="gap-2 rounded-none border-b-2 border-transparent data-active:border-primary data-active:bg-transparent data-active:shadow-none px-4 py-3">
              <Database className="w-4 h-4" />
              备份
            </TabsTrigger>
            <TabsTrigger value="about" className="gap-2 rounded-none border-b-2 border-transparent data-active:border-primary data-active:bg-transparent data-active:shadow-none px-4 py-3">
              <Info className="w-4 h-4" />
              使用方法
            </TabsTrigger>
          </TabsList>

          <TabsContent value="models" className="min-h-0 overflow-y-auto p-4 sm:p-6 mt-0 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">模型级独立配置</p>
                <p className="text-xs text-muted-foreground">每个模型单独记录协议、模型 ID、API Key；Base URL 统一固定为 RKAPI 网关。</p>
              </div>
              <Button onClick={persistRegistry} className="gap-2">
                <Save className="w-4 h-4" />
                保存设置
              </Button>
            </div>

            {error && <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
            {success && <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">{success}</div>}
            {externalConfigNotice && (
              <div className="rounded-lg border border-primary/20 bg-primary/10 p-3 text-sm text-primary">
                {externalConfigNotice}
              </div>
            )}

            {needsImageModelKeyGuide && (
              <div className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/10 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <KeyRound className="h-4 w-4" />
                  </div>
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">{imageModelKeyGuide.title}</p>
                    <p className="text-muted-foreground">{imageModelKeyGuide.description}</p>
                  </div>
                </div>
                <a
                  href={imageModelKeyGuide.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({ className: 'shrink-0 gap-2' })}
                >
                  {imageModelKeyGuide.ctaLabel}
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
            )}

            <div className="rounded-xl border p-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">图片模型</p>
                  <p className="text-xs text-muted-foreground">默认提供 RKAPI 图片模型，填入 API Key 后即可使用。</p>
                </div>
                <Button variant="outline" size="sm" className="gap-2" onClick={handleAddImageModel}>
                  <Plus className="w-4 h-4" />
                  新增图片模型
                </Button>
              </div>

              <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
                <div className="space-y-2">
                  {imageModels.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => setSelectedImageModelId(model.id)}
                      className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${selectedImageModelId === model.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}
                    >
                      <div className="font-medium">{model.name || '未命名模型'}</div>
                      <div className="text-xs text-muted-foreground">{isCompleteImageModel(model) ? '配置完成' : '待补全'}</div>
                    </button>
                  ))}
                </div>

                {selectedImageModel && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">内置模板</label>
                      <Select
                        value={selectedImageModel.builtinPreset}
                        onValueChange={(value) => handleUpdateImageModel(selectedImageModel.id, { builtinPreset: value as ImageModelConfig['builtinPreset'] })}
                        options={BUILTIN_IMAGE_PRESET_OPTIONS}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">协议</label>
                      <Select
                        value={selectedImageModel.protocol}
                        disabled={isXaiImaginePresetId(selectedImageModel.builtinPreset)}
                        onValueChange={(value) => handleUpdateImageModel(selectedImageModel.id, { protocol: value as ProviderProtocol })}
                        options={[
                          { value: 'google', label: 'Google' },
                          { value: 'openai', label: 'OpenAI Images' },
                        ]}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">显示名称</label>
                      <Input value={selectedImageModel.name} disabled />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">模型 ID</label>
                      <Input
                        value={selectedImageModel.modelId}
                        placeholder={BUILTIN_IMAGE_PRESETS[selectedImageModel.builtinPreset].modelId}
                        onChange={(event) => handleUpdateImageModel(selectedImageModel.id, {
                          modelId: event.target.value,
                        })}
                      />
                      <p className="text-xs text-muted-foreground">默认使用 gpt-image-2，可按实际上游模型 ID 修改。</p>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Base URL</label>
                      <Input value={selectedImageModel.baseUrl} disabled />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">API Key</label>
                      <div className="relative">
                        <Input
                          type={showImageApiKey ? "text" : "password"}
                          value={selectedImageModel.apiKey}
                          onChange={(event) => handleUpdateImageModel(selectedImageModel.id, { apiKey: event.target.value })}
                          className="pr-8"
                        />
                        <button
                          type="button"
                          onClick={() => setShowImageApiKey(!showImageApiKey)}
                          className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          tabIndex={-1}
                        >
                          {showImageApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">最大参考图数量</label>
                      <Input
                        type="number"
                        min={1}
                        max={isXaiImaginePresetId(selectedImageModel.builtinPreset) ? 1 : undefined}
                        disabled={isXaiImaginePresetId(selectedImageModel.builtinPreset)}
                        value={selectedImageModel.maxRefImages}
                        onChange={(event) => handleUpdateImageModel(selectedImageModel.id, { maxRefImages: Number(event.target.value) || 1 })}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">最大分辨率</label>
                      <Select
                        value={selectedImageModel.maxOutputSize}
                        onValueChange={(value) => handleUpdateImageModel(selectedImageModel.id, { maxOutputSize: value as ImageModelConfig['maxOutputSize'] })}
                        options={selectedImageOutputSizes.map((size) => ({ value: size, label: getOutputSizeLabel(size) }))}
                      />
                    </div>
                    {selectedImageModel.protocol === 'google' && (
                      <div className="md:col-span-2 flex items-center justify-between rounded-lg border px-3 py-2">
                        <div>
                          <p className="text-sm font-medium">温度参数</p>
                          <p className="text-xs text-muted-foreground">仅在当前上游图片模型明确兼容 Gemini temperature 参数时开启；关闭后工作台不会显示或发送温度。</p>
                        </div>
                        <Switch
                          checked={Boolean(selectedImageModel.supportsTemperature)}
                          onCheckedChange={(checked) => handleUpdateImageModel(selectedImageModel.id, { supportsTemperature: checked })}
                        />
                      </div>
                    )}
                    {selectedImageModel.protocol === 'openai' && selectedImageModel.builtinPreset === 'gpt-image-2' && (
                      <div className="grid gap-3 md:col-span-2">
                        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                          <div>
                            <p className="text-sm font-medium">Image 2 额外参数</p>
                            <p className="text-xs text-muted-foreground">透明度、质量、风格控件默认开启，用户可手动关闭。</p>
                          </div>
                          <Switch
                            checked={selectedImageModel.supportsAdvancedParams}
                            onCheckedChange={(checked) => handleUpdateImageModel(selectedImageModel.id, { supportsAdvancedParams: checked })}
                          />
                        </div>
                        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                          <div>
                            <p className="text-sm font-medium">流式图片请求</p>
                            <p className="text-xs text-muted-foreground">向 OpenAI Images 兼容接口发送 stream=true，可降低 Cloudflare/Nginx 长连接 504 风险；上游不支持时会直接报告错误。</p>
                          </div>
                          <Switch
                            checked={Boolean(selectedImageModel.streamImages)}
                            onCheckedChange={(checked) => handleUpdateImageModel(selectedImageModel.id, { streamImages: checked })}
                          />
                        </div>
                      </div>
                    )}
                    <div className="md:col-span-2 flex justify-end">
                      <Button variant="outline" size="sm" className="gap-2 text-destructive hover:text-destructive" onClick={() => handleDeleteImageModel(selectedImageModel.id)}>
                        <Trash2 className="w-4 h-4" />
                        删除模型
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border p-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">文本模型</p>
                  <p className="text-xs text-muted-foreground">可选。仅 Agent、反推、提示词优化、图片描述等功能需要。</p>
                </div>
                <Button variant="outline" size="sm" className="gap-2" onClick={handleAddTextModel}>
                  <Plus className="w-4 h-4" />
                  新增文本模型
                </Button>
              </div>

              <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
                <div className="space-y-2">
                  {textModels.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => setSelectedTextModelId(model.id)}
                      className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${selectedTextModelId === model.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}
                    >
                      <div className="font-medium">{model.name || '未命名模型'}</div>
                      <div className="text-xs text-muted-foreground">{isCompleteTextModel(model) ? '配置完成' : '待补全'}</div>
                    </button>
                  ))}
                </div>

                {selectedTextModel && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">协议</label>
                      <Select
                        value={selectedTextModel.protocol}
                        onValueChange={(value) => {
                          const protocol = value as ProviderProtocol;
                          handleUpdateTextModel(selectedTextModel.id, { protocol });
                          handleApplyTextTemplate(selectedTextModel.id, protocol);
                        }}
                        options={[
                          { value: 'openai', label: 'OpenAI Response' },
                          { value: 'google', label: 'Google Gemini' },
                        ]}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">显示名称</label>
                      <Input value={selectedTextModel.name} disabled />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">模型 ID</label>
                      <Input value={selectedTextModel.modelId} onChange={(event) => handleUpdateTextModel(selectedTextModel.id, { modelId: event.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">Base URL</label>
                      <Input value={selectedTextModel.baseUrl} disabled />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">API Key</label>
                      <div className="relative">
                        <Input
                          type={showTextApiKey ? "text" : "password"}
                          value={selectedTextModel.apiKey}
                          onChange={(event) => handleUpdateTextModel(selectedTextModel.id, { apiKey: event.target.value })}
                          className="pr-8"
                        />
                        <button
                          type="button"
                          onClick={() => setShowTextApiKey(!showTextApiKey)}
                          className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          tabIndex={-1}
                        >
                          {showTextApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <label className="text-xs text-muted-foreground">协议描述</label>
                      <Input value={selectedTextModel.note || ''} onChange={(event) => handleUpdateTextModel(selectedTextModel.id, { note: event.target.value })} />
                    </div>
                    <div className="md:col-span-2 flex justify-end">
                      <Button variant="outline" size="sm" className="gap-2 text-destructive hover:text-destructive" onClick={() => handleDeleteTextModel(selectedTextModel.id)}>
                        <Trash2 className="w-4 h-4" />
                        删除模型
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border p-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">默认模型</p>
                  <p className="text-xs text-muted-foreground">这里只会显示已经配置完整的模型。</p>
                </div>
                <Button variant="outline" size="sm" className="gap-2" onClick={handleCheckModels} disabled={checkingModels}>
                  <RefreshCw className={`w-4 h-4 ${checkingModels ? 'animate-spin' : ''}`} />
                  {checkingModels ? '检查中...' : '检查模型'}
                </Button>
              </div>

              <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">启用提示词优化按钮</p>
                  <p className="text-xs text-muted-foreground">默认关闭。开启后会显示优化入口，并使用下方的提示词优化默认文本模型。</p>
                </div>
                <Switch
                  checked={promptOptimizeEnabled}
                  onCheckedChange={handlePromptOptimizeToggle}
                  aria-label="启用提示词优化按钮"
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">文生图默认模型</label>
                  <Select value={defaults.textToImage} onValueChange={(value) => setDefaults((prev) => ({ ...prev, textToImage: value }))} options={completeImageOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">图生图默认模型</label>
                  <Select value={defaults.imageToImage} onValueChange={(value) => setDefaults((prev) => ({ ...prev, imageToImage: value }))} options={completeImageOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">反推提示词默认模型</label>
                  <Select value={defaults.reversePrompt} onValueChange={(value) => setDefaults((prev) => ({ ...prev, reversePrompt: value }))} options={completeTextOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">Agent 默认模型</label>
                  <Select value={defaults.agent} onValueChange={(value) => setDefaults((prev) => ({ ...prev, agent: value }))} options={completeTextOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">提示词优化默认模型</label>
                  <Select value={defaults.promptOptimize} onValueChange={(value) => setDefaults((prev) => ({ ...prev, promptOptimize: value }))} options={completeTextOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">图片描述默认模型</label>
                  <Select value={defaults.imageDescribe} onValueChange={(value) => setDefaults((prev) => ({ ...prev, imageDescribe: value }))} options={completeTextOptions} />
                </div>
              </div>

              {modelCheckError && <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{modelCheckError}</div>}
              {modelStatuses && (
                <div className="grid gap-2 md:grid-cols-2">
                  {modelStatuses.map((status) => (
                    <div key={status.modelId} className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{getTextModelLabel(textModels, status.modelId) ?? getImageModelLabel(imageModels, status.modelId) ?? status.actualName ?? status.modelId}</div>
                        <div className="truncate text-xs text-muted-foreground">{status.message || status.actualName || status.modelId}</div>
                      </div>
                      {status.available ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-destructive" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="backup" className="min-h-0 overflow-y-auto p-4 sm:p-6 space-y-6 mt-0">
            <div className="space-y-4">
              <div className="space-y-2">
                <h3 className="text-base font-medium">数据备份与恢复</h3>
                <p className="text-sm text-muted-foreground">导出所有数据（模型配置、任务历史、设置、图片）为 ZIP 压缩包，或从备份文件恢复数据。</p>
              </div>

              <BackupProgress percent={backupProgress.percent} message={backupProgress.message} isActive={isBackupActive} />

              {backupSuccess && !isBackupActive && (
                <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
                  <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-emerald-600 dark:text-emerald-500 mt-0.5" />
                  <p className="text-sm text-emerald-900 dark:text-emerald-100">{backupSuccess}</p>
                </div>
              )}

              {backupError && !isBackupActive && (
                <div className="flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-4">
                  <XCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-destructive break-all">{backupError}</p>
                </div>
              )}

              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-start gap-3">
                  <Download className="w-5 h-5 text-muted-foreground mt-0.5" />
                  <div className="flex-1 space-y-2">
                    <h4 className="font-medium">导出数据</h4>
                    <p className="text-sm text-muted-foreground">将所有数据打包为 ZIP 文件下载到本地。备份文件包含模型配置和本地记录，请自行保管。</p>
                    <Button onClick={handleExport} disabled={isBackupActive} className="gap-2">
                      <Download className="w-4 h-4" />
                      全量备份
                    </Button>
                  </div>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-start gap-3">
                  <Upload className="w-5 h-5 text-muted-foreground mt-0.5" />
                  <div className="flex-1 space-y-2">
                    <h4 className="font-medium">导入数据</h4>
                    <p className="text-sm text-muted-foreground">从备份文件恢复数据。<span className="font-medium text-destructive">警告：这会覆盖现有数据。</span></p>
                    <input ref={fileInputRef} type="file" accept=".zip" onChange={handleFileSelect} className="hidden" />
                    <Button onClick={() => fileInputRef.current?.click()} disabled={isBackupActive} variant="outline" className="gap-2">
                      <Upload className="w-4 h-4" />
                      选择备份文件
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="about" className="min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4 mt-0">
            <div className="space-y-4 text-sm">
              <h3 className="text-lg font-medium">使用方法 <span className="text-xs text-muted-foreground font-normal">v{platformVersion}</span></h3>
              <ol className="list-decimal list-inside space-y-3 text-muted-foreground">
                <li>
                  <span className="font-medium text-foreground">填写模型密钥：</span>
                  在“模型配置”中为 <code>RKAPI-逆向</code>、<code>RKAPI-4k</code> 和 <code>RKAPI</code> 填入对应 API Key；Base URL 已固定为 <code>https://api.rkai6.com</code>。
                </li>
                <li>
                  <span className="font-medium text-foreground">补全模型 ID：</span>
                  图片模型 ID 默认是 <code>gpt-image-2</code>，可按实际上游模型 ID 修改；文本模型 ID 默认是 <code>gpt-5.6-sol</code>。
                </li>
                <li>
                  <span className="font-medium text-foreground">保存并选择默认模型：</span>
                  保存后，在“默认模型”区域选择文生图、图生图、反推、Agent、提示词优化和图片描述的默认模型。
                </li>
                <li>
                  <span className="font-medium text-foreground">开始使用：</span>
                  回到工作台提交文生图或图生图任务；反推、Agent 和提示词优化功能会使用已配置的 <code>RKAPI</code> 文本模型。
                </li>
              </ol>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

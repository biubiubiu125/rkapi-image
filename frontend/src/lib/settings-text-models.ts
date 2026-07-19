import {
  RKAPI_DEFAULT_TEXT_MODEL_ID,
  getResolvedImageModelId,
  type ImageModelConfig,
  type TextModelConfig,
} from '@/lib/flyreq-models';

function hasTextApiKey(model: TextModelConfig): boolean {
  return Boolean(model.apiKey.trim());
}

function isCompleteImageModel(model: ImageModelConfig): boolean {
  return Boolean(
    model.name.trim()
    && getResolvedImageModelId(model)
    && model.apiKey.trim()
    && model.baseUrl.trim()
  );
}

function isCompleteTextModel(model: TextModelConfig): boolean {
  return Boolean(
    model.name.trim()
    && model.modelId.trim()
    && model.apiKey.trim()
    && model.baseUrl.trim()
  );
}

export function getPersistableTextModelsForSettingsSave(models: TextModelConfig[]): TextModelConfig[] {
  return models.filter((model) => model.id === RKAPI_DEFAULT_TEXT_MODEL_ID || hasTextApiKey(model));
}

export function getEnabledTextModelsForSettingsSave(models: TextModelConfig[]): TextModelConfig[] {
  return models.filter(hasTextApiKey);
}

export function getSettingsModelSaveError(input: {
  imageModels: ImageModelConfig[];
  enabledTextModels: TextModelConfig[];
  promptOptimizeEnabled: boolean;
}): string | null {
  const hasCompleteImageModel = input.imageModels.some(isCompleteImageModel);
  const hasEnabledTextModel = input.enabledTextModels.length > 0;
  const hasCompleteEnabledTextModel = input.enabledTextModels.some(isCompleteTextModel);

  if (input.imageModels.length === 0 && !hasEnabledTextModel) {
    return '至少填写一个图片模型或文本模型';
  }
  if (!hasCompleteImageModel && !hasCompleteEnabledTextModel) {
    return '至少完成一个图片模型或文本模型的全部信息';
  }
  if (hasEnabledTextModel && !input.enabledTextModels.every(isCompleteTextModel)) {
    return '文本模型如需启用，请填写完整；不需要文本功能时可以留空或删除';
  }
  if (input.promptOptimizeEnabled && !hasCompleteEnabledTextModel) {
    return '启用提示词优化前，请先完成至少一个文本模型配置';
  }
  return null;
}

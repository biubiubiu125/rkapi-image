'use client';

import { useEffect, useState } from 'react';
import {
  applyBuiltinImagePresetModelIds,
  applyDeploymentDefaultImageModel,
  type BuiltinImagePresetModelIds,
  type DeploymentDefaultImageModelConfig,
} from '@/lib/flyreq-models';

// 1 = 常驻（直接显示） 2 = 私密（需密码） 3 = 关闭（完全隐藏）
export type PromptGalleryMode = '1' | '2' | '3';

/**
 * 加载服务端运行时配置，并在模型工作区渲染前应用部署级默认模型。
 * @returns 提示词广场配置与运行时配置加载状态。
 */
export function usePromptGalleryConfig() {
  const [mode, setMode] = useState<PromptGalleryMode>('2'); // 默认私密
  const [passwordEnabled, setPasswordEnabled] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/flyreq/config', { cache: 'no-store' })
      .then(res => res.json())
      .then((data: {
        promptGalleryMode?: string;
        promptGalleryPasswordEnabled?: boolean;
        imagePresetModelIds?: BuiltinImagePresetModelIds;
        defaultImageModel?: DeploymentDefaultImageModelConfig;
      }) => {
        if (cancelled) return;
        applyBuiltinImagePresetModelIds(data.imagePresetModelIds);
        applyDeploymentDefaultImageModel(data.defaultImageModel);
        const raw = data.promptGalleryMode;
        setMode(raw === '1' || raw === '3' ? raw : '2');
        setPasswordEnabled(Boolean(data.promptGalleryPasswordEnabled));
      })
      .catch(() => {
        applyBuiltinImagePresetModelIds();
        applyDeploymentDefaultImageModel();
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    return () => { cancelled = true; };
  }, []);

  return { mode, passwordEnabled, ready };
}

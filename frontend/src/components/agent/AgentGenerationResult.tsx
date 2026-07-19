'use client';

import { useState, useCallback } from 'react';
import { Brain, Copy, Check, Clock, Loader2, RefreshCw, Sparkles, Image as ImageIcon, MessageSquare, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { renderReasoning } from '@/lib/render-reasoning';
import { MAX_PARALLEL_COUNT } from '@/lib/model-capabilities';
import type { AgentPhase } from '@/hooks/useAgentChat';
import { useI18n } from '@/components/LanguageProvider';
import type { I18nKey } from '@/lib/i18n';

interface AgentGenerationResultProps {
  text: string;
  reasoning?: string;
}

interface AgentGenerationProgressProps {
  analysis: string;
  reasoning?: string;
  prompt: string;
  parallelCount: number;
  phase: AgentPhase;
  elapsedSeconds: number;
  taskId?: string;
  isSyncing?: boolean;
  checkNowDisabled?: boolean;
  onCheckNow?: () => void;
  onSkipDescribing?: () => void;
}

interface ParsedSection {
  label: string;
  content: string;
  icon: React.ReactNode;
  color: string;
}

interface GenerationSectionCardProps {
  section: ParsedSection;
  copiedText: string | null;
  onCopy: (content: string, label: string) => void;
  t: (key: I18nKey, values?: Record<string, string | number>) => string;
}

/**
 * 解析新旧语言写入的生成结果文本，并以当前界面语言显示区块标题。
 * @param text 已持久化的生成结果文本，兼容中文与英文标题。
 * @param t 当前语言的翻译函数。
 * @returns 用于渲染的生成结果区块列表。
 */
function parseGenerationText(text: string, t: (key: I18nKey) => string): ParsedSection[] {
  const sections: ParsedSection[] = [];

  const analysisMatch = text.match(/(?:^|\n)(?:分析|Analysis)\s*[:：]\s*([\s\S]*?)(?=\n(?:优化提示词|Optimized prompt)\s*[:：]|$)/i);
  if (analysisMatch) {
    sections.push({
      label: t('agentGeneration.analysis'),
      content: analysisMatch[1].trim(),
      icon: <Brain className="h-3.5 w-3.5" />,
      color: 'text-blue-500',
    });
  }

  const promptMatch = text.match(/(?:^|\n)(?:优化提示词|Optimized prompt)\s*[:：]\s*([\s\S]*?)(?=\n(?:结果|Result)\s*[:：]|$)/i);
  if (promptMatch) {
    sections.push({
      label: t('agentGeneration.optimizedPrompt'),
      content: promptMatch[1].trim(),
      icon: <Sparkles className="h-3.5 w-3.5" />,
      color: 'text-purple-500',
    });
  }

  const resultMatch = text.match(/(?:^|\n)(?:结果|Result)\s*[:：]\s*([\s\S]*?)$/i);
  if (resultMatch) {
    sections.push({
      label: t('agentGeneration.result'),
      content: resultMatch[1].trim(),
      icon: <ImageIcon className="h-3.5 w-3.5" />,
      color: 'text-green-500',
    });
  }

  // 如果没有匹配到任何部分，返回原始文本作为分析
  if (sections.length === 0) {
    sections.push({
      label: t('agentGeneration.analysis'),
      content: text,
      icon: <Brain className="h-3.5 w-3.5" />,
      color: 'text-blue-500',
    });
  }

  return sections;
}

function getProgressLabel(phase: AgentPhase, hasTaskId: boolean, t: (key: I18nKey) => string): string {
  switch (phase) {
    case 'generating':
      return hasTaskId ? t('agentGeneration.generating') : t('agentGeneration.submitting');
    case 'loading':
      return t('agentGeneration.retrieving');
    case 'describing':
      return t('agentGeneration.describing');
    default:
      return t('agentGeneration.preparing');
  }
}

function GenerationSectionCard({ section, copiedText, onCopy, t }: GenerationSectionCardProps) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/80 p-3 transition-colors hover:bg-card">
      <div className="mb-2 flex items-center justify-between">
        <div className={cn('flex items-center gap-2 text-xs font-medium', section.color)}>
          {section.icon}
          {section.label}
        </div>
        <button
          type="button"
          onClick={() => onCopy(section.content, section.label)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          title={`${t('common.copy')} ${section.label}`}
        >
          {copiedText === section.label ? (
            <Check className="h-3 w-3" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {copiedText === section.label ? t('common.copied') : t('common.copy')}
        </button>
      </div>
      <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {section.content}
      </div>
    </div>
  );
}

export function AgentGenerationResult({ text, reasoning }: AgentGenerationResultProps) {
  const { t } = useI18n();
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const sections = parseGenerationText(text, t);

  const handleCopy = useCallback(async (content: string, label: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedText(label);
      setTimeout(() => setCopiedText(null), 2000);
    } catch {
      // 剪贴板写入失败静默忽略
    }
  }, []);

  return (
    <div className="space-y-3">
      {/* 思考过程（可折叠） */}
      {reasoning && (
        <details className="group">
          <summary className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground">
            <MessageSquare className="h-3.5 w-3.5" />
            {t('agentGeneration.reasoning')}
            <span className="text-[10px] opacity-60 group-open:rotate-90 transition-transform">▶</span>
          </summary>
          <div className="mt-2 rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">
            <div dangerouslySetInnerHTML={{ __html: renderReasoning(reasoning) }} />
          </div>
        </details>
      )}

      {/* 结构化显示三个部分 */}
      {sections.map((section, index) => (
        <GenerationSectionCard
          key={index}
          section={section}
          copiedText={copiedText}
          onCopy={handleCopy}
          t={t}
        />
      ))}
    </div>
  );
}

export function AgentGenerationProgress({
  analysis,
  reasoning,
  prompt,
  parallelCount,
  phase,
  elapsedSeconds,
  taskId,
  isSyncing = false,
  checkNowDisabled = false,
  onCheckNow,
  onSkipDescribing,
}: AgentGenerationProgressProps) {
  const { t } = useI18n();
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const progressLabel = getProgressLabel(phase, Boolean(taskId), t);
  const placeholderCount = Math.max(1, Math.min(MAX_PARALLEL_COUNT, Math.trunc(parallelCount) || 1));
  const sections: ParsedSection[] = [
    {
      label: t('agentGeneration.analysis'),
      content: analysis || t('agentGeneration.defaultAnalysis'),
      icon: <Brain className="h-3.5 w-3.5" />,
      color: 'text-blue-500',
    },
    {
      label: t('agentGeneration.optimizedPrompt'),
      content: prompt,
      icon: <Sparkles className="h-3.5 w-3.5" />,
      color: 'text-purple-500',
    },
  ];

  const handleCopy = useCallback(async (content: string, label: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedText(label);
      setTimeout(() => setCopiedText(null), 2000);
    } catch {
      // 剪贴板写入失败静默忽略
    }
  }, []);

  return (
    <div className="space-y-3 animate-in fade-in-0 slide-in-from-bottom-2 duration-200">
      {reasoning && (
        <details className="group">
          <summary className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground">
            <MessageSquare className="h-3.5 w-3.5" />
            {t('agentGeneration.reasoning')}
            <span className="text-[10px] opacity-60 transition-transform group-open:rotate-90">▶</span>
          </summary>
          <div className="mt-2 rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">
            <div dangerouslySetInnerHTML={{ __html: renderReasoning(reasoning) }} />
          </div>
        </details>
      )}

      {sections.map((section, index) => (
        <GenerationSectionCard
          key={index}
          section={section}
          copiedText={copiedText}
          onCopy={handleCopy}
          t={t}
        />
      ))}

      <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span className="font-medium text-foreground">{progressLabel}</span>
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Clock className="h-3.5 w-3.5" />
            {elapsedSeconds}s
          </span>
          {taskId && (
            <span className="min-w-0 max-w-[14rem] truncate rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px] sm:max-w-[18rem]">
              {taskId}
            </span>
          )}
          {(phase === 'describing') && onSkipDescribing && (
            <button
              type="button"
              onClick={() => {
                if (confirm(t('agentGeneration.skipConfirm'))) {
                  onSkipDescribing();
                }
              }}
              className="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
              title={t('agentGeneration.skipDescription')}
            >
              <X className="h-3 w-3" />
              {t('agentGeneration.skipDescription')}
            </button>
          )}
          {phase === 'generating' && taskId && onCheckNow && (
            <button
              type="button"
              onClick={onCheckNow}
              disabled={checkNowDisabled}
              className="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              title={checkNowDisabled ? t('agentGeneration.waitBeforeCheck') : t('agentGeneration.checkNow')}
            >
              {isSyncing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {t('agentGeneration.checkNow')}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {Array.from({ length: placeholderCount }, (_, index) => (
          <div
            key={index}
            className="relative h-24 w-24 overflow-hidden rounded-lg border border-border bg-muted"
            aria-label={t('agentGeneration.imageGenerating', { index: index + 1 })}
          >
            <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-muted via-background/70 to-muted" />
            <div className="absolute inset-y-0 -left-full w-1/2 animate-shimmer bg-gradient-to-r from-transparent via-white/30 to-transparent dark:via-white/10" />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-[10px] text-muted-foreground">
              <ImageIcon className="h-4 w-4" />
              <span>{t('agentGeneration.generatingShort')}</span>
              <span className="tabular-nums">#{index + 1}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

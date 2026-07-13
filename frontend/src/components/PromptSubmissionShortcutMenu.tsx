'use client';

import { Keyboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dispatchImageActionToast } from '@/lib/image-actions';
import { getPromptSubmissionShortcutLabels, type PromptSubmissionShortcut } from '@/hooks/usePromptSubmissionShortcut';

interface PromptSubmissionShortcutMenuProps {
  value: PromptSubmissionShortcut;
  isSmallViewport: boolean;
  onValueChange: (shortcut: PromptSubmissionShortcut) => void;
}

/**
 * 渲染提示词发送快捷键的选择菜单。
 * @param props 当前快捷键及其变更回调。
 * @returns 快捷键选择按钮与菜单。
 */
export function PromptSubmissionShortcutMenu({ value, isSmallViewport, onValueChange }: PromptSubmissionShortcutMenuProps) {
  /**
   * 校验菜单返回值后通知父组件更新偏好，避免写入未知值。
   * @param shortcut 菜单返回的快捷键值。
   * @returns 无返回值。
   */
  const handleValueChange = (shortcut: string) => {
    if (shortcut === 'enter' || shortcut === 'shift-enter') {
      if (shortcut === value) return;
      onValueChange(shortcut);
      const labels = getPromptSubmissionShortcutLabels(shortcut);
      const mobileNotice = isSmallViewport ? '；当前窄屏请点击发送按钮提交' : '';
      dispatchImageActionToast(`已设置：${labels.submission} 发送，${labels.newline} 换行${mobileNotice}`, 'success');
    }
  };

  const currentShortcutLabels = getPromptSubmissionShortcutLabels(value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" />}
        aria-label="发送快捷键"
        title={isSmallViewport ? '窄屏模式：点击发送按钮提交' : `发送快捷键：${currentShortcutLabels.submission} 发送，${currentShortcutLabels.newline} 换行`}
      >
        <Keyboard className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuRadioGroup value={value} onValueChange={handleValueChange}>
          <DropdownMenuLabel>{isSmallViewport ? '窄屏模式：点击发送按钮提交' : '发送与换行快捷键'}</DropdownMenuLabel>
          <DropdownMenuRadioItem value="enter">
            <span>Enter 发送</span>
            <span className="ml-auto text-xs text-muted-foreground">Shift + Enter 换行</span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="shift-enter">
            <span>Shift + Enter 发送</span>
            <span className="ml-auto text-xs text-muted-foreground">Enter 换行</span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

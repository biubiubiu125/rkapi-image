import { describe, expect, it } from 'vitest';

import {
  GPT_IMAGE_QUALITY_OPTIONS,
  getGptImageResolution,
  getOutputSizeLabel,
} from '@/lib/model-capabilities';

describe('model capabilities', () => {
  it('keeps GPT Image quality labels separate from resolution labels', () => {
    expect(GPT_IMAGE_QUALITY_OPTIONS).toEqual([
      { value: 'auto', label: '自动' },
      { value: 'high', label: '高' },
      { value: 'medium', label: '中' },
      { value: 'low', label: '低' },
    ]);
  });

  it('displays output size labels as compact resolution tiers', () => {
    expect(getOutputSizeLabel('1K')).toBe('1k');
    expect(getOutputSizeLabel('2K')).toBe('2k');
    expect(getOutputSizeLabel('4K')).toBe('4k');
  });

  it('keeps GPT Image generated sizes inside OpenAI documented limits', () => {
    expect(getGptImageResolution('1K', '1:1')).toBe('1024x1024');
    expect(getGptImageResolution('2K', '1:1')).toBe('2048x2048');
    expect(getGptImageResolution('4K', '16:9')).toBe('3840x2160');
    expect(getGptImageResolution('4K', '1:1')).toBe('2880x2880');
  });
});

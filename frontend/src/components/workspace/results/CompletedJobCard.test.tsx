import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '@/components/LanguageProvider';
import { CompletedJobCard } from '@/components/workspace/results/CompletedJobCard';
import { resolveStoredImageRef } from '@/lib/image-downloader';
import type { StoredJob } from '@/lib/job-store';

vi.mock('@/hooks/useImageLazyLoad', () => ({
  useImageLazyLoad: () => ({
    elementRef: { current: null },
    isVisible: true,
    isLoaded: true,
    placeholderHeight: 200,
    handleImageLoad: vi.fn(),
  }),
}));

vi.mock('@/lib/image-downloader', async () => {
  const actual = await vi.importActual<typeof import('@/lib/image-downloader')>('@/lib/image-downloader');
  return {
    ...actual,
    resolveStoredImageRef: vi.fn(),
    revokeBlobUrls: vi.fn(),
  };
});

const mockedResolveStoredImageRef = vi.mocked(resolveStoredImageRef);

function makeCompletedJob(overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    id: 'job-1',
    status: 'completed',
    mode: 'text-to-image',
    prompt: 'prompt',
    output_size: '1K',
    temperature: 1,
    aspect_ratio: '1:1',
    model: 'rkapi-4k-image',
    created_at: '2026-06-07T00:00:00.000Z',
    completed_at: '2026-06-07T00:00:10.000Z',
    images: ['IDB:job-1-0', 'IDB:job-1-1', 'IDB:job-1-2'],
    imageData: 'IDB:job-1-0',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedResolveStoredImageRef.mockImplementation(async (_jobId, _image, index) => ({
    image: `blob:job-1-${index}`,
    blobUrl: `blob:job-1-${index}`,
  }));
});

describe('CompletedJobCard image previews', () => {
  it('resolves all visible multi-image IDB thumbnails after refresh', async () => {
    render(
      <LanguageProvider initialLocale="zh">
        <CompletedJobCard
          job={makeCompletedJob()}
          onClear={vi.fn()}
          onRetry={vi.fn()}
          onRetryDownload={vi.fn()}
        />
      </LanguageProvider>,
    );

    await waitFor(() => {
      expect(mockedResolveStoredImageRef).toHaveBeenCalledWith('job-1', 'IDB:job-1-0', 0);
      expect(mockedResolveStoredImageRef).toHaveBeenCalledWith('job-1', 'IDB:job-1-1', 1);
      expect(mockedResolveStoredImageRef).toHaveBeenCalledWith('job-1', 'IDB:job-1-2', 2);
    });

    expect(screen.getByAltText('Generated image 1')).toHaveAttribute('src', 'blob:job-1-0');
    expect(screen.getByAltText('Generated image 2')).toHaveAttribute('src', 'blob:job-1-1');
    expect(screen.getByAltText('Generated image 3')).toHaveAttribute('src', 'blob:job-1-2');
  });
});

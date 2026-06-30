import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TextToImageForm } from '../TextToImageForm'
import { LanguageProvider } from '../LanguageProvider'

vi.mock('@/lib/image-actions', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/image-actions')>()
  return {
    ...actual,
    dispatchImageActionToast: vi.fn(),
  }
})

import { dispatchImageActionToast } from '@/lib/image-actions'

const TEST_REGISTRY = {
  imageModels: [{
    id: 'flyreq-gpt-image-2',
    protocol: 'openai',
    name: 'FlyReq',
    modelId: 'gpt-image-2',
    apiKey: 'test-api-key',
    baseUrl: 'https://api.openai.com',
    builtinPreset: 'gpt-image-2',
    maxRefImages: 16,
    maxOutputSize: '4K',
    supportsAdvancedParams: true,
  }],
  textModels: [],
  defaults: { textToImage: 'flyreq-gpt-image-2', imageToImage: 'flyreq-gpt-image-2' },
}

function renderForm(props: React.ComponentProps<typeof TextToImageForm>) {
  return render(
    <LanguageProvider initialLocale="zh">
      <TextToImageForm {...props} />
    </LanguageProvider>
  )
}

describe('TextToImageForm', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('flyreq-model-registry', JSON.stringify(TEST_REGISTRY))
    vi.mocked(dispatchImageActionToast).mockClear()
  })

  it('renders the form with placeholder text', () => {
    const onSubmit = vi.fn()
    renderForm({ onSubmit })

    expect(screen.getByPlaceholderText('描述你想要生成的图像...')).toBeInTheDocument()
  })

  it('submit button is disabled when prompt is empty', () => {
    const onSubmit = vi.fn()
    renderForm({ onSubmit })

    const submitButton = screen.getByRole('button', { name: '' }) // Arrow icon button
    expect(submitButton).toBeDisabled()
  })

  it('submit button is enabled when prompt has text', () => {
    const onSubmit = vi.fn()
    renderForm({ onSubmit })

    const textarea = screen.getByPlaceholderText('描述你想要生成的图像...')
    fireEvent.change(textarea, { target: { value: 'A beautiful sunset' } })

    const submitButton = screen.getByRole('button', { name: '' })
    expect(submitButton).not.toBeDisabled()
  })

  it('calls onSubmit with prompt when Shift+Enter is pressed', () => {
    const onSubmit = vi.fn()
    renderForm({ onSubmit })

    const textarea = screen.getByPlaceholderText('描述你想要生成的图像...')
    fireEvent.change(textarea, { target: { value: 'A beautiful sunset' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompts: ['A beautiful sunset'],
      outputSize: '1K',
      aspectRatio: '1:1',
      temperature: 1,
      model: 'flyreq-gpt-image-2',
      gptImageQuality: 'auto',
      gptImageStyle: 'auto',
      gptImageBackground: 'auto',
      gptImageOutputFormat: 'png',
      parallelCount: 1,
    }))
  })

  it('keeps the prompt and shows a message when no image model is selected', () => {
    const onSubmit = vi.fn()
    localStorage.removeItem('flyreq-model-registry')
    localStorage.setItem('flyreq-t2i-settings', JSON.stringify({ model: '' }))
    renderForm({ onSubmit })

    const textarea = screen.getByPlaceholderText('描述你想要生成的图像...')
    fireEvent.change(textarea, { target: { value: 'A beautiful sunset' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(textarea).toHaveValue('A beautiful sunset')
    expect(dispatchImageActionToast).toHaveBeenCalledWith(
      '请先选择图片模型，或在设置中配置可用的图片模型。',
      'error',
    )
  })

  it('shows image params control for GPT Image 2 model', async () => {
    const onSubmit = vi.fn()
    renderForm({ onSubmit, initialData: { model: 'flyreq-gpt-image-2' } })

    expect(await screen.findByTitle('图像参数')).toBeInTheDocument()
  })

  it('submits default image params for GPT Image 2 model when left on auto', async () => {
    const onSubmit = vi.fn()
    renderForm({ onSubmit, initialData: { model: 'flyreq-gpt-image-2', prompt: 'Cut out the subject' } })

    const textarea = screen.getByPlaceholderText('描述你想要生成的图像...')
    await screen.findByTitle('图像参数')
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      model: 'flyreq-gpt-image-2',
      gptImageQuality: 'auto',
      gptImageStyle: 'auto',
      gptImageBackground: 'auto',
      gptImageOutputFormat: 'png',
    }))
  })

  it('does NOT submit when plain Enter is pressed', () => {
    const onSubmit = vi.fn()
    renderForm({ onSubmit })

    const textarea = screen.getByPlaceholderText('描述你想要生成的图像...')
    fireEvent.change(textarea, { target: { value: 'A beautiful sunset' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('shows configuration prompt when disabled prop is true', () => {
    const onSubmit = vi.fn()
    renderForm({ onSubmit, disabled: true })

    expect(screen.getByText('API 密钥未配置')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '配置' })).toBeInTheDocument()
  })
})

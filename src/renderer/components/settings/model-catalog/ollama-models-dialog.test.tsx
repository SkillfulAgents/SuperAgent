// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const state = vi.hoisted(() => ({ pulls: [] as unknown[], start: vi.fn() }))
vi.mock('@renderer/hooks/use-ollama', () => ({
  useOllamaStatus: () => ({
    data: { state: 'running', baseUrl: 'http://localhost:11434', upgradeRequired: false, models: [{ id: 'qwen3.8:latest', label: 'qwen3.8', supportsThinking: true, supportsImageInput: false }] },
  }),
  useOllamaPulls: () => ({ pulls: state.pulls, start: { mutate: state.start, isError: false }, cancel: { mutate: vi.fn() } }),
}))

import { OllamaModelsDialog } from './ollama-models-dialog'

function renderDialog(canDownload = true) {
  render(<OllamaModelsDialog open onOpenChange={() => {}} baseUrl="http://localhost:11434" canDownload={canDownload} />)
}
const type = (value: string) => fireEvent.change(screen.getByTestId('ollama-model-name'), { target: { value } })
const submit = () => screen.getByTestId('ollama-pull-submit') as HTMLButtonElement

beforeEach(() => {
  state.pulls = []
  state.start.mockReset()
})

describe('OllamaModelsDialog', () => {
  it('downloads a name typed in, trimmed', () => {
    renderDialog()
    type(' qwen3.8:27b ')
    fireEvent.click(submit())
    expect(state.start).toHaveBeenCalledWith('qwen3.8:27b', expect.anything())
  })

  it('says what is wrong with a name before sending it', () => {
    renderDialog()
    expect(screen.queryByRole('alert')).toBeNull()
    type('qwen 3')
    expect(screen.getByRole('alert').textContent).toContain('such as qwen3.8')
    expect(submit().disabled).toBe(true)
    type('glm-5.3:cloud')
    expect(screen.getByRole('alert').textContent).toContain('Cloud models')
  })

  it('does not download a model it already has, with or without its tag', () => {
    renderDialog()
    type('qwen3.8')
    expect(screen.getByRole('alert').textContent).toBe('Already downloaded')
    expect(submit().disabled).toBe(true)
  })

  it('points to ollama.com to find a name', () => {
    renderDialog()
    expect(screen.getByRole('link', { name: /Browse models on ollama.com/ }).getAttribute('href')).toContain('ollama.com/search')
  })

  it('shows a download to someone who cannot download, without a form or a Cancel they could not use', () => {
    state.pulls = [{ model: 'm:latest', state: 'running', phase: 'pulling', completedBytes: 1, totalBytes: 2 }]
    renderDialog(false)
    expect(screen.getByTestId('ollama-pull-m:latest')).toBeTruthy()
    expect(screen.queryByTestId('ollama-model-name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel downloading m:latest' })).toBeNull()
  })
})

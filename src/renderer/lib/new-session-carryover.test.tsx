// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { Attachment } from '@renderer/components/messages/attachment-preview'
import { splitComposerSnapshot } from './new-session-carryover'
import type { SecuredSecret } from './secret-detection'

describe('splitComposerSnapshot', () => {
  it('moves text, attachments, model, and effort without retaining object URLs', () => {
    const attachment: Attachment = {
      type: 'file',
      id: 'image-1',
      file: new File(['image'], 'image.png', { type: 'image/png' }),
      preview: 'blob:source-preview',
    }

    const result = splitComposerSnapshot({
      text: '  keep this text  ',
      attachments: [attachment],
      model: 'sonnet',
      effort: 'high',
      speed: 'fast',
    })

    expect(result.draftText).toBe('  keep this text  ')
    expect(result.carryover).toEqual({
      attachments: [{ ...attachment, preview: undefined }],
      model: 'sonnet',
      effort: 'high',
      speed: 'fast',
    })
    expect(attachment.preview).toBe('blob:source-preview')
  })

  it('does not overwrite an existing destination draft with blank text', () => {
    expect(splitComposerSnapshot({
      text: '   ',
      attachments: [],
      model: 'opus',
      effort: 'medium',
      speed: 'normal',
    }).draftText).toBeUndefined()
  })

  it('carries secure-pill metadata so a moved draft still sends an environment placeholder', () => {
    const securedSecret: SecuredSecret = {
      id: 'secret-1',
      key: 'GitHub Token',
      envVar: 'GITHUB_TOKEN',
      displayText: '[GitHub Token | *********]',
    }

    expect(splitComposerSnapshot({
      text: 'Use [GitHub Token | *********]',
      attachments: [],
      model: 'sonnet',
      effort: 'high',
      speed: 'normal',
      securedSecrets: [securedSecret],
    }).carryover).toEqual({
      attachments: [],
      model: 'sonnet',
      effort: 'high',
      speed: 'normal',
      securedSecrets: [securedSecret],
    })
  })
})

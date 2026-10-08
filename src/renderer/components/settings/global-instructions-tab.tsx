import { useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { MarkdownComposerEditor } from '@renderer/components/messages/markdown-composer-editor'
import { useUser } from '@renderer/context/user-context'
import { useGlobalInstructions, useUpdateSettings } from '@renderer/hooks/use-settings'
import { GLOBAL_INSTRUCTIONS_MAX_LENGTH } from '@shared/lib/config/global-instructions-schema'

const SECTION_HEADING = 'text-xs font-medium text-muted-foreground px-1'

export function GlobalInstructionsTab() {
  const { isAuthMode, isAdmin } = useUser()
  const canEdit = !isAuthMode || isAdmin
  const { data, isLoading } = useGlobalInstructions()
  const updateSettings = useUpdateSettings()
  const saved = data?.globalInstructions ?? ''
  const [draft, setDraft] = useState(saved)

  // Follow the server copy until the editor diverges from it, so a save
  // elsewhere (or the first load) shows up without clobbering an edit.
  const [baseline, setBaseline] = useState(saved)
  useEffect(() => {
    if (saved === baseline) return
    if (draft === baseline) setDraft(saved)
    setBaseline(saved)
  }, [saved, baseline, draft])

  const hasChanges = draft !== saved
  const tooLong = draft.length > GLOBAL_INSTRUCTIONS_MAX_LENGTH

  const handleSave = () => {
    const next = draft.trim()
    updateSettings.mutate({ globalInstructions: next }, { onSuccess: () => setDraft(next) })
  }

  return (
    <div className="space-y-2">
      <h3 className={SECTION_HEADING}>Global guidance</h3>
      <div className="rounded-md border border-input px-3 py-2 shadow-sm focus-within:ring-1 focus-within:ring-ring">
        <MarkdownComposerEditor
          value={draft}
          onChange={setDraft}
          placeholder={canEdit ? 'Guidance every agent should follow, e.g. tone, conventions, or things to never do…' : 'No global guidance has been set.'}
          minRows={16}
          disabled={!canEdit || isLoading}
          dataTestId="global-instructions-editor"
          ariaLabel="Global guidance"
          toolbar={canEdit}
        />
      </div>
      <div className="flex items-start gap-3 px-1">
        <p className="flex-1 text-[11px] text-muted-foreground leading-relaxed">
          Added to the system prompt of every agent as a &ldquo;Global Guidance&rdquo; section, ahead of each
          agent&apos;s own instructions. Changes take effect from each session&apos;s next message.
          {!canEdit && ' Only admins can edit it.'}
        </p>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-3">
            <span className={`text-[11px] tabular-nums ${tooLong ? 'text-destructive' : 'text-muted-foreground'}`}>
              {draft.length.toLocaleString()} / {GLOBAL_INSTRUCTIONS_MAX_LENGTH.toLocaleString()}
            </span>
            {hasChanges && (
              <Button variant="outline" size="sm" onClick={() => setDraft(saved)} disabled={updateSettings.isPending}>
                Discard
              </Button>
            )}
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!hasChanges || tooLong || updateSettings.isPending}
              data-testid="global-instructions-save"
            >
              {updateSettings.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </div>
      {updateSettings.error && (
        <p className="px-1 text-[11px] text-destructive">{updateSettings.error.error}</p>
      )}
    </div>
  )
}

'use client'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useState } from 'react'
import { useCreateSession } from '@/lib/hooks/use-sessions'

interface CreateSessionDialogProps {
  agentSlug: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (sessionId: string) => void
}

export function CreateSessionDialog({
  agentSlug,
  open,
  onOpenChange,
  onCreated,
}: CreateSessionDialogProps) {
  const [message, setMessage] = useState('')
  const createSession = useCreateSession()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!message.trim()) return

    try {
      const session = await createSession.mutateAsync({
        agentSlug,
        message: message.trim(),
      })
      setMessage('')
      onOpenChange(false)
      onCreated?.(session.id)
    } catch (error) {
      console.error('Failed to create session:', error)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New Session</DialogTitle>
            <DialogDescription>
              Start a new conversation session with this agent.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <Textarea
              placeholder="Type your first message..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="min-h-[100px] resize-none"
              autoFocus
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!message.trim() || createSession.isPending}>
              {createSession.isPending ? 'Creating...' : 'Start Session'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

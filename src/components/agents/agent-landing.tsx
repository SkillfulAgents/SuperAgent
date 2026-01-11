'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Send, Loader2, Sparkles } from 'lucide-react'
import { useCreateSession } from '@/lib/hooks/use-sessions'
import { useAgentSkills } from '@/lib/hooks/use-agent-skills'
import type { AgentWithStatus } from '@/lib/hooks/use-agents'

interface AgentLandingProps {
  agent: AgentWithStatus
  onSessionCreated: (sessionId: string) => void
}

export function AgentLanding({ agent, onSessionCreated }: AgentLandingProps) {
  const [message, setMessage] = useState('')
  const createSession = useCreateSession()
  const { data: skills } = useAgentSkills(agent.id)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!message.trim() || createSession.isPending) return

    try {
      // Single API call: creates session, sends message, generates name in background
      const session = await createSession.mutateAsync({
        agentId: agent.id,
        message: message.trim(),
      })

      setMessage('')
      onSessionCreated(session.id)
    } catch (error) {
      console.error('Failed to start session:', error)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-2xl space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold">
            Start a conversation with {agent.name}
          </h1>
          <p className="text-muted-foreground">
            Send a message to begin a new session
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <Textarea
              placeholder="Type your message..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              className="min-h-[120px] pr-12 resize-none text-base"
              disabled={createSession.isPending}
              autoFocus
            />
            <Button
              type="submit"
              size="icon"
              className="absolute bottom-3 right-3"
              disabled={!message.trim() || createSession.isPending}
            >
              {createSession.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground text-center">
            Press Enter to send, Shift+Enter for new line
          </p>
        </form>

        {/* Skills Section */}
        {skills && skills.length > 0 && (
          <div className="pt-6 border-t">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium text-muted-foreground">
                Available Skills
              </h2>
            </div>
            <div className="grid gap-2">
              {skills.map((skill) => (
                <div
                  key={skill.path}
                  className="flex items-start gap-3 p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{skill.name}</p>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {skill.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

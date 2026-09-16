import type { AgentIntegrationRecord as ChatIntegration } from '../agent-integrations/types'
import { isMultiPartyChatType, type ChatConnectorClass, type IncomingMessage } from './chat-agent-integration'
import { parseChatIntegrationConfig, type ChatProvider } from './config-schema'
import { sanitizeUploadFilename, withUploadTimestamp } from '../utils/path-safety'
import { isHostOrSubdomain, tryParseUrl } from '../utils/url-safety'
import { agentRegistry } from '../agent-actor'
import { captureException } from '../error-reporting'
const MAX_FILE_DOWNLOAD_SIZE = 50 * 1024 * 1024
const reportError = (err: unknown, operation: string, extra?: Record<string, unknown>, level?: 'error' | 'warning') =>
  captureException(err, { tags: { component: 'chat-integration', operation }, extra, level })
function isTrustedSlackDownloadHost(u: URL): boolean {
  return u.protocol === 'https:' && isHostOrSubdomain(u.hostname, 'slack.com')
}

export class ChatInputBuilder {
  constructor(private readonly getConnectorClass: (provider: string) => Promise<ChatConnectorClass | undefined>) {}
  async buildMessageContent(
    integration: ChatIntegration,
    message: IncomingMessage,
  ): Promise<{ text: string; failedFiles: string[] }> {
    // Attribution is best-effort metadata, so lookup failure falls back to no prefix.
    let connectorClass: ChatConnectorClass | undefined
    try {
      connectorClass = await this.getConnectorClass(integration.provider)
    } catch { /* fall through to the no-prefix default */ }
    const sender = message.userName || message.userId
    const prefix = sender
      && isMultiPartyChatType(connectorClass?.classifyChatId?.(message))
      ? `\\[${sender}]: `
      : ''
    const text = prefix + (message.text || '')

    if (!message.files || message.files.length === 0) {
      return { text, failedFiles: [] }
    }

    const { appendAttachedFiles } = await import('@shared/lib/utils/attached-files')
    const uploadedPaths: string[] = []
    const failedFiles: string[] = []

    let transcribedText = text
    for (const file of message.files) {
      if (!file.url) {
        failedFiles.push(file.name)
        continue
      }

      try {
        const data = await this.downloadFileBuffer(integration, file.url)
        if (data) {
          // For iMessage voice notes, try to transcribe audio files
          if (integration.provider === 'imessage' && file.mimeType?.startsWith('audio/')) {
            const transcript = await this.tryTranscribeAudio(data, file.mimeType)
            if (transcript) {
              transcribedText = (transcribedText ? transcribedText + '\n' : '') + `[Voice note: "${transcript}"]`
              continue
            }
            // Transcription unavailable — fall through to file attachment
            transcribedText = (transcribedText ? transcribedText + '\n' : '') + '[Voice note — transcription unavailable]'
          }
          const path = await this.writeToWorkspace(integration.agentSlug, file.name, data)
          uploadedPaths.push(path)
        } else {
          failedFiles.push(file.name)
        }
      } catch (err) {
        console.error(`[ChatAgentIntegration] Failed to download file ${file.name}:`, err)
        failedFiles.push(file.name)
      }
    }

    return { text: appendAttachedFiles(transcribedText, uploadedPaths), failedFiles }
  }

  /** Download a file from the chat platform, returning a Buffer. */
  private async downloadFileBuffer(integration: ChatIntegration, fileUrl: string): Promise<Buffer | null> {
    try {
      const config = parseChatIntegrationConfig(
        integration.provider as ChatProvider,
        integration.config,
      )
      if (!config) return null

      if (integration.provider === 'slack' && 'botToken' in config) {
        return await this.downloadSlackFile(config.botToken, fileUrl)
      }

      // Telegram & iMessage: direct URL download (no auth needed)
      const response = await fetch(fileUrl)
      if (!response.ok) return null
      const buffer = Buffer.from(await response.arrayBuffer())
      if (!this.validateFileContent(buffer)) return null
      return buffer
    } catch (err) {
      console.error(`[ChatAgentIntegration] File download failed:`, err)
      return null
    }
  }

  /** Download a Slack file using the Web API (requires files:read scope). */
  private async downloadSlackFile(botToken: string, fileUrl: string): Promise<Buffer | null> {
    // Extract file ID from Slack URL: .../files-pri/TEAM-FILEID/...
    const fileIdMatch = fileUrl.match(/files-pri\/[A-Z0-9]+-([A-Z0-9]+)/)
    if (!fileIdMatch) {
      // Fallback: try direct download with auth
      return this.downloadWithAuth(fileUrl, botToken)
    }

    const fileId = fileIdMatch[1]

    // Use files.info API to get a proper download URL
    const infoRes = await fetch(`https://slack.com/api/files.info?file=${fileId}`, {
      headers: { 'Authorization': `Bearer ${botToken}` },
    })
    const info = await infoRes.json() as { ok: boolean; file?: { url_private_download?: string }; error?: string }

    if (!info.ok || !info.file?.url_private_download) {
      console.error(`[ChatAgentIntegration] Slack files.info failed: ${info.error || 'no download URL'}`)
      return null
    }

    return this.downloadWithAuth(info.file.url_private_download, botToken)
  }

  /**
   * Download a URL with Bearer auth, following redirects manually.
   *
   * The Slack bot token is attached ONLY when the next hop is an HTTPS request
   * to a trusted Slack host (SUP-232). Slack download URLs redirect to signed S3
   * URLs whose auth lives in the query string, so dropping the header on
   * cross-origin hops does not break legitimate downloads — but it prevents the
   * xoxb token from leaking to an attacker-controlled redirect target.
   */
  private async downloadWithAuth(url: string, token: string): Promise<Buffer | null> {
    let target = tryParseUrl(url)
    if (!target) {
      console.error('[ChatAgentIntegration] Invalid Slack download URL')
      return null
    }

    const headersFor = (u: URL): Record<string, string> =>
      isTrustedSlackDownloadHost(u) ? { 'Authorization': `Bearer ${token}` } : {}

    let response = await fetch(target.toString(), { headers: headersFor(target), redirect: 'manual' })
    // Follow redirects, re-evaluating auth for every hop.
    let redirects = 0
    while (response.status >= 300 && response.status < 400 && redirects < 5) {
      const location = response.headers.get('location')
      if (!location) break
      // Resolve relative redirects against the current URL.
      const next = tryParseUrl(location, target)
      if (!next) {
        console.error('[ChatAgentIntegration] Invalid redirect location in Slack download')
        return null
      }
      target = next
      response = await fetch(target.toString(), { headers: headersFor(target), redirect: 'manual' })
      redirects++
    }

    if (!response.ok) {
      console.error(`[ChatAgentIntegration] File download HTTP ${response.status} for ${url}`)
      return null
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (!this.validateFileContent(buffer)) {
      return null
    }
    return buffer
  }

  /** Validate downloaded content is actual file data, not an HTML error page. */
  private validateFileContent(buffer: Buffer): boolean {
    if (buffer.length === 0) {
      console.error('[ChatAgentIntegration] Downloaded file is empty')
      return false
    }
    if (buffer.length > MAX_FILE_DOWNLOAD_SIZE) {
      console.error(`[ChatAgentIntegration] Downloaded file too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB, limit ${MAX_FILE_DOWNLOAD_SIZE / 1024 / 1024} MB)`)
      return false
    }
    // Check for HTML content (Slack login pages, error pages)
    if (buffer.length > 15) {
      const head = buffer.slice(0, 15).toString('utf8').toLowerCase()
      if (head.includes('<!doctype') || head.includes('<html')) {
        console.error('[ChatAgentIntegration] Downloaded file is HTML, not a valid file (missing files:read scope?)')
        return false
      }
    }
    return true
  }

  /** Write a file to the agent's workspace uploads directory. */
  private async writeToWorkspace(agentSlug: string, filename: string, data: Buffer): Promise<string> {
    // External attachment names are attacker-controlled — sanitize to a safe
    // basename so `../` segments cannot leave the uploads directory. The
    // actor's containment keeps the write inside the workspace, but it does
    // not stop a name from landing one level up, so the basename is still ours.
    const safeName = sanitizeUploadFilename(filename)
    const uploadName = withUploadTimestamp(safeName)
    await agentRegistry.get(agentSlug).files.putDoc(`uploads/${uploadName}`, data)

    return `/workspace/uploads/${uploadName}`
  }

  /** Pre-warm the agent container so it's ready when the user's message arrives. */
  private async tryTranscribeAudio(audioBuffer: Buffer, mimeType: string): Promise<string | null> {
    try {
      const { getConfiguredVoiceProvider } = await import('@shared/lib/voice')
      const provider = getConfiguredVoiceProvider()
      if (!provider || !provider.supportsTranscription()) return null
      const transcript = await provider.transcribe(audioBuffer, mimeType)
      return transcript || null
    } catch (err) {
      console.error('[ChatAgentIntegration] Audio transcription failed:', err)
      reportError(err, 'transcribe-audio', {}, 'warning')
      return null
    }
  }

}

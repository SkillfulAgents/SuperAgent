import type { EmailMessage } from './config-schema'

/** Conservative local heuristic, not a guarantee against prompt injection. No external call. */
export function screenUnsolicitedEmail(message: EmailMessage): boolean {
  // This text-only filter cannot assess opaque attachments; require owner review.
  if (message.attachments.length) return false
  const text = `${message.subject ?? ''}\n${message.text ?? message.html ?? ''}`
  if (text.length > 32000) return false
  const patterns = [
    /(?:ignore|override|disregard|forget)[\s\S]{0,70}(?:instructions|system prompt|policy|rules)/i,
    /(?:reveal|print|send|show|export|upload)[\s\S]{0,80}(?:api.?key|password|secret|token|system prompt|credentials)/i,
    /(?:bypass|disable|skip)[\s\S]{0,50}(?:approval|security|permission|authentication)/i,
    /(?:<\/?(?:system|developer)>|\[INST\]|BEGIN SYSTEM)/i,
  ]
  return !patterns.some(pattern => pattern.test(text))
}

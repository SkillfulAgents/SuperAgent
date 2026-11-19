/** System-prompt note for a chat session that replaces an earlier one. */
export function continuationPrompt(sessionId: string): string {
  return [
    '<previous_session>',
    `This chat continues an earlier session with the same person: ${sessionId}.`,
    `When the new message depends on something said before, read it with \`uv run /opt/gamut/bin/read-session.py ${sessionId}\` (\`--limit 40\` for the last turns, \`--grep <word>\` to search). For older sessions, use \`uv run /opt/gamut/bin/list-sessions.py\`.`,
    '</previous_session>',
  ].join('\n')
}

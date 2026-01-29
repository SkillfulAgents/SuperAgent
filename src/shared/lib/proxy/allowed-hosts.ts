// Per-toolkit allowlist of target hosts.
// The proxy rejects requests to hosts not in this list for the account's toolkit.
export const TOOLKIT_ALLOWED_HOSTS: Record<string, string[]> = {
  gmail: ['gmail.googleapis.com', 'www.googleapis.com'],
  googlecalendar: ['www.googleapis.com'],
  googledrive: ['www.googleapis.com'],
  slack: ['slack.com'],
  github: ['api.github.com'],
  notion: ['api.notion.com'],
  linear: ['api.linear.app'],
  twitter: ['api.twitter.com', 'api.x.com'],
  discord: ['discord.com'],
  trello: ['api.trello.com'],
}

export function isHostAllowed(toolkit: string, host: string): boolean {
  const allowed = TOOLKIT_ALLOWED_HOSTS[toolkit]
  if (!allowed) return false
  return allowed.includes(host)
}

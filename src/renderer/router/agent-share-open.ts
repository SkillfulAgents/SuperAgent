/**
 * One-shot "open the header Share popover on the next agent home."
 * Slug-free: only one agent home mounts after the @-menu click.
 */
let pending = false

export function requestAgentShareOpen() {
  pending = true
}

export function agentShareOpenRequested(): boolean {
  return pending
}

export function clearAgentShareOpen() {
  pending = false
}

/** Copy for an event wake with no clock time. Empty names must not join to a blank. */
export function eventWakeWaitingLabel(waitingOn?: string[]): string {
  const names = (waitingOn ?? []).filter((name) => name.length > 0)
  return names.length > 0
    ? `Waiting for ${names.join(', ')} to finish`
    : 'Waiting for agents to finish'
}

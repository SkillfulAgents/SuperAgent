/**
 * Runtime options attached to a composer send.
 *
 * A QUEUED (mid-turn) send must not carry model/effort/speed — the container
 * treats a parameter change as interrupt/restart of the in-flight query. The
 * autopilot flag is the exception and must survive queueing: the server reads
 * a flag-less message as coming from an autopilot-unaware surface and shuts an
 * engaged autopilot off entirely (the day-one guardrail), which is exactly
 * wrong for a steering message typed with the switch visibly on. An absent
 * flag stays absent — no flag must never read as a toggle-off.
 */
export function buildMessageSendOptions<T extends { autopilot?: boolean }>(
  queued: boolean,
  options: T
): Partial<T> {
  if (!queued) return options
  return ('autopilot' in options ? { autopilot: options.autopilot } : {}) as Partial<T>
}

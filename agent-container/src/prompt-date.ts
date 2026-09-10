/**
 * The calendar facts the system prompt states about "now", in the zone the
 * container runs in (the TZ env the host sets to the agent owner's zone).
 */
export interface PromptDate {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  weekday: string;
  /** IANA zone name, e.g. America/Los_Angeles. */
  timeZone: string;
  /** e.g. UTC-07:00 */
  utcOffset: string;
}

export function promptDate(
  now: Date = new Date(),
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): PromptDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    timeZoneName: 'longOffset',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  // longOffset renders a zero offset as bare "GMT".
  const offset = part('timeZoneName');
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    weekday: part('weekday'),
    timeZone,
    utcOffset: offset === 'GMT' ? 'UTC+00:00' : offset.replace('GMT', 'UTC'),
  };
}

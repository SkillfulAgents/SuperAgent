import { CronExpressionParser, type CronExpressionOptions } from 'cron-parser'

const ZERO_FIELDS = [
  { error: 'CronSecond', key: 'second', index: 0 },
  { error: 'CronMinute', key: 'minute', index: 1 },
  { error: 'CronHour', key: 'hour', index: 2 },
  { error: 'CronDayOfWeek', key: 'dayOfWeek', index: 5 },
] as const
const MAX_FIELD_VALUES = 256

/**
 * Preserve stored schedules accepted by cron-parser 5.5 whose lists repeated
 * zero (including Sunday as both 0 and 7). Its duplicate check treated zero as
 * falsy, so those equivalent value sets used to work. Parse normally first:
 * upstream still owns syntax, expansion/length limits and all date arithmetic.
 */
export function parseScheduleCron(expression: string, options?: CronExpressionOptions) {
  let candidate = expression
  for (let repairs = 0; ; repairs += 1) {
    try {
      return CronExpressionParser.parse(candidate, options)
    } catch (error) {
      const field = ZERO_FIELDS.find(({ error: name }) =>
        error instanceof Error && error.message === `${name} Validation error, duplicate values found: 0`
      )
      // Retrying hashed fields could redraw their values. THU is an ordinary
      // weekday alias, not a hash; only an H without a following letter counts.
      if (!field || repairs === ZERO_FIELDS.length || /H(?![A-Za-z])/.test(candidate)) throw error

      const fields = candidate.trim().split(/\s+/)
      const index = field.index - (6 - fields.length)
      if (index < 0) throw error

      const values = fields[index].split(',').flatMap<number | string>((atom) => {
        const isolated = ['*', '*', '*', '*', '*', '*']
        isolated[field.index] = atom
        return CronExpressionParser.parse(isolated.join(' ')).fields[field.key].values
      })
      // Upstream checks the cumulative count before each atom; the final range
      // can cross its limit. Never let deduplication hide that extra expansion.
      if (values.length > MAX_FIELD_VALUES) {
        throw new Error(`Constraint error, too many values in ${field.key} field, expected at most ${MAX_FIELD_VALUES}`)
      }
      // A range can retain Sunday as 7 while an individual 7 parses as 0.
      // This field already contains duplicate 0, so they are equivalent here.
      const normalized = values.map(value => field.key === 'dayOfWeek' && value === 7 ? 0 : value)
      // The old falsy-zero check also masked later duplicates in the
      // same field. Other fields still undergo the normal upstream validation.
      fields[index] = [...new Set(normalized)].join(',')
      // Keep an explicit list explicit: collapsing a full weekday set to '*'
      // would change its OR relationship with a restricted day-of-month field.
      candidate = fields.join(' ')
    }
  }
}

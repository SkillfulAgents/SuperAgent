import type { CSSProperties } from 'react'

/**
 * The bottom spacer of a create step with nothing below its block (the name
 * and add-ons steps, and the job step without its template roster), against
 * a top spacer of `flex-1`: centred, the same on every step so the header
 * does not jump between them.
 */
export const CREATE_STEP_BOTTOM_SPACER: CSSProperties = { flex: '1 1 0%' }

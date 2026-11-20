import type { CSSProperties } from 'react'

/**
 * The bottom spacer of a create step with nothing below its block (the name
 * and add-ons steps, and the job step without its template roster), against
 * a top spacer of `flex-1`: centred, the same on every step so the header
 * does not jump between them.
 */
export const CREATE_STEP_BOTTOM_SPACER: CSSProperties = { flex: '1 1 0%' }

/**
 * The orb on every create step carries this `view-transition-name`, so a
 * change of step (one view transition, `useCreateAgentFlow`) moves the one
 * orb from its place on the old step to its place on the new, at its new
 * size, instead of swapping one for another. Only the step on screen may
 * render it: two live elements with one name cancel the transition. Its
 * timing is in globals.css.
 */
export const CREATE_AGENT_ORB_TRANSITION = { viewTransitionName: 'create-agent-orb' } as CSSProperties

export type LinkAction = 'message' | 'read'
/** `out`: this agent does it to the other one. `in`: the other agent does it to this one. */
export type LinkDirection = 'out' | 'in'
/** A standing decision only. A request waiting for an answer lives on its card, not here. */
export type LinkEnd = 'allowed' | 'ask' | 'blocked'
export type LinkLine = Record<LinkDirection, LinkEnd>

/** One direction's end, from the decision saved for this pair. Nothing saved means it asks first. */
export function linkEnd(decision: 'allow' | 'review' | 'block' | 'default'): LinkEnd {
  if (decision === 'allow') return 'allowed'
  if (decision === 'block') return 'blocked'
  return 'ask'
}

export const isOn = (end: LinkEnd): boolean => end === 'allowed'

/** "Analytics Tzar’s", "my agents’". */
export const possessive = (name: string): string => name.endsWith('s') ? `${name}’` : `${name}’s`

/** What a line says, in full, so the arrowheads never have to be read alone. */
export function lineWords(action: LinkAction, line: LinkLine, self: string, other = 'the agent'): string {
  const others = possessive(other)
  const out = isOn(line.out)
  const inn = isOn(line.in)
  const m = action === 'message'
  if (out && inn) return m ? 'can message each other' : 'can read each other’s chats'
  if (out) return m ? `${self} can message ${other}` : `${self} can read ${others} chats`
  if (inn) return m ? `${other} can message ${self}` : `${other} can read ${possessive(self)} chats`
  if (line.out === 'blocked' && line.in === 'blocked') return m ? 'messages · blocked' : 'chats · blocked'
  if (line.out === 'blocked') return m ? `${self} can’t message ${other}` : `${self} can’t read ${others} chats`
  if (line.in === 'blocked') return m ? `${other} can’t message ${self}` : `${other} can’t read ${possessive(self)} chats`
  return m ? 'messages · asks first' : 'chats · asks first'
}

const other = (direction: LinkDirection): LinkDirection => direction === 'out' ? 'in' : 'out'

/** What a click saves for one end: an Allow or a Block for this pair, or `clear` to remove what is saved. */
export type LinkWrite = 'allow' | 'block' | 'clear'
export interface LinkChange { direction: LinkDirection; write: LinkWrite }

/** A click on one arrowhead. A plain click never blocks or unblocks. */
export function endClick(end: LinkEnd): LinkWrite | null {
  if (end === 'ask') return 'allow'
  return end === 'allowed' ? 'clear' : null
}

/**
 * A click on the middle of a line. On: turn off every end that is on. Off: turn on the direction this agent
 * starts (`first`), or the other one when that end is blocked. Never lifts a Block. Empty when nothing changes.
 */
export function middleClick(line: LinkLine, first: LinkDirection): LinkChange[] {
  const order: LinkDirection[] = [first, other(first)]
  const lit = order.filter((d) => isOn(line[d]))
  if (lit.length > 0) return lit.map((direction) => ({ direction, write: 'clear' }))
  const target = order.find((d) => line[d] === 'ask')
  return target ? [{ direction: target, write: 'allow' }] : []
}

/** Whether an end is drawn: the reverse end stays hidden while the line is off and nothing is saved for it. */
export function showsEnd(line: LinkLine, direction: LinkDirection, first: LinkDirection): boolean {
  const off = !isOn(line.out) && !isOn(line.in)
  return !(off && direction !== first && line[direction] === 'ask')
}

export type LinkChoice = 'allow' | 'ask' | 'block'

/** The right-click menu's current choice for an end. */
export function menuChoice(end: LinkEnd): LinkChoice {
  if (isOn(end)) return 'allow'
  return end === 'blocked' ? 'block' : 'ask'
}

/** What a right-click choice saves. "Ask first" removes what is saved, since nothing saved means it asks first. */
export function menuWrite(choice: LinkChoice): LinkWrite {
  return choice === 'ask' ? 'clear' : choice
}

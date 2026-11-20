import { isSystemMessageText } from './system-message'
import { parseSignInMethodRequestMessage } from './sign-in-method-request'
import { parseCommandMessage } from './message-transform'

/** How the CLI's own stop marker starts ("[Request interrupted by user]", "… for tool use]"). */
export const INTERRUPT_MARKER_PREFIX = '[Request interrupted by user'

const COMPACT_COMMAND = /^\/compact(?:\s|$)/

/**
 * Whether a user message with this text is one the message list draws as a
 * turn's opening bubble: something a person sent, which stays on screen and
 * which the turn's work folds under.
 *
 * The page reader counts these to decide that a page holds enough to fill a
 * screen (see MESSAGES_PAGE_MIN_TURNS), so it errs toward false: a message it
 * does not count only makes the page longer. Not counted:
 *  - system-injected notices (`[SYSTEM] …`), which the list hides, and the
 *    notices that share the prefix and draw as one thin line;
 *  - the sign-in form's request, which folds away with the turn's work;
 *  - a stop marker, a badge the list drops when a notice explains it;
 *  - `/compact`, which the list pairs with its boundary instead of a bubble;
 *  - a local command's output, which the transform turns into an agent reply.
 *
 * `user-message-kinds/index.test.ts` pins this against the renderer's
 * registry: nothing counted here may be hidden or folded there.
 */
export function startsVisibleTurn(text: string): boolean {
  if (isSystemMessageText(text)) return false
  if (text.startsWith(INTERRUPT_MARKER_PREFIX)) return false
  if (COMPACT_COMMAND.test(text.trimStart())) return false
  if (parseSignInMethodRequestMessage(text) !== null) return false
  if (parseCommandMessage(text)?.type === 'command-output') return false
  return true
}

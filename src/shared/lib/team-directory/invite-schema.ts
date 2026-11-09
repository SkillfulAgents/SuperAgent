/** What the join form reads about an invite link (GET /api/auth/invite/:token). Shared with the renderer. */
export interface InviteDetails {
  name: string
  email: string
  /** Who invited them, while that account exists. */
  invitedBy: string | null
  /** Whether they can join with a password; otherwise only single sign-on, which claims the invite by email. */
  passwordJoin: boolean
  passwordMinLength: number
  passwordRequireComplexity: boolean
}

/** The query parameter an invite link carries its token in. */
export const INVITE_LINK_PARAM = 'invite'

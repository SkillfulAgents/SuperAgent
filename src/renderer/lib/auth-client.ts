import { createAuthClient } from 'better-auth/react'
import { adminClient, genericOAuthClient } from 'better-auth/client/plugins'

// In Electron production builds the renderer loads from file://, which better-auth
// rejects.  Provide a dummy http URL when not in auth mode so the module can
// load without throwing.  The client is never actually used when auth is off.
const baseURL =
  typeof window !== 'undefined' && window.location.protocol === 'file:'
    ? 'http://localhost'
    : undefined

export const authClient = createAuthClient({
  baseURL,
  plugins: [adminClient(), genericOAuthClient()],
})

export const { signIn, signUp, signOut, useSession } = authClient

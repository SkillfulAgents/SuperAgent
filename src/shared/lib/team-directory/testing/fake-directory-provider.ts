/**
 * A directory provider for tests only. It goes through every path a real one
 * does (registry, sealed credentials, cache, search, routes), which is how the
 * tests show nothing outside `providers/` depends on which provider it is.
 *
 *   const fake = createFakeDirectoryProvider()
 *   const unregister = registerDirectoryProvider(fake.provider)
 *   fake.setPeople('acme', [fake.person('acme', 'u1', 'Dana Whitfield', 'dana@acme.test')])
 */
import { z } from 'zod'
import { DirectoryConnectError, type DirectoryMessage, type DirectoryUser, type TeamDirectoryProvider } from '../types'

const credentialsSchema = z.object({ token: z.string().min(1) })
type FakeCredentials = z.infer<typeof credentialsSchema>

export interface FakeDirectory {
  provider: TeamDirectoryProvider<FakeCredentials>
  /** The people the workspace a token names (`<tenantId>-token`) lists. */
  setPeople(tenantId: string, people: DirectoryUser[]): void
  /** The next listings of this workspace throw. */
  failListings(tenantId: string, error?: Error | null): void
  /** Holds listings until the returned function is called. */
  holdListings(): () => void
  person(tenantId: string, remoteId: string, name: string, email?: string, extra?: Partial<DirectoryUser>): DirectoryUser
  listCalls: string[]
  sent: Array<{ user: DirectoryUser; message: DirectoryMessage }>
}

export function createFakeDirectoryProvider(id = 'fake', label = 'Fake Directory'): FakeDirectory {
  const people = new Map<string, DirectoryUser[]>()
  const failures = new Map<string, Error>()
  let held: Promise<void> | null = null
  const fake: FakeDirectory = {
    listCalls: [],
    sent: [],
    setPeople: (tenantId, list) => { people.set(tenantId, list) },
    failListings: (tenantId, error = new DirectoryConnectError('The fake directory is down')) => {
      if (error) failures.set(tenantId, error)
      else failures.delete(tenantId)
    },
    holdListings: () => {
      let release!: () => void
      held = new Promise((resolve) => { release = resolve })
      return () => { held = null; release() }
    },
    person: (tenantId, remoteId, name, email, extra) => ({
      provider: id, tenantId, remoteId, name, ...(email ? { email } : {}), emailVerified: !!email, ...extra,
    }),
    provider: {
      info: {
        id,
        label,
        description: 'A directory for tests.',
        fields: [{ key: 'token', label: 'Token', secret: true }],
        steps: ['Paste a token named after the workspace, ending in -token.'],
      },
      credentialsSchema,
      async verify({ token }) {
        const tenantId = token.replace(/-token$/, '')
        if (tenantId === token) throw new DirectoryConnectError('That is not a fake token')
        return { tenantId, tenantName: tenantId.toUpperCase() }
      },
      open({ tenantId }) {
        return {
          async listUsers() {
            fake.listCalls.push(tenantId)
            if (held) await held
            const failure = failures.get(tenantId)
            if (failure) throw failure
            return people.get(tenantId) ?? []
          },
          async notifyUser(user, message) {
            fake.sent.push({ user, message })
          },
        }
      },
    },
  }
  return fake
}

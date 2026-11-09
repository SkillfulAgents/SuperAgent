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
import {
  DirectoryConnectError,
  ProvisioningCredentialsError,
  type AgentAppIdentity,
  type AgentIdentityProvisioning,
  type DirectoryMessage,
  type DirectoryUser,
  type ProvisionedAppRecord,
  type TeamDirectoryProvider,
} from '../types'

const credentialsSchema = z.object({ token: z.string().min(1) })
type FakeCredentials = z.infer<typeof credentialsSchema>

/** A rotating pair like Slack's configuration token: `generation` goes up with each rotation. */
const provisioningSchema = z.object({ key: z.string().min(1), generation: z.number().default(0), expiresAt: z.number().optional() })
type FakeProvisioningCredentials = z.infer<typeof provisioningSchema>

export interface FakeProvisioner {
  /** Calls in order, without icons' bytes. */
  calls: Array<{ op: 'create' | 'install' | 'delete' | 'update' | 'rotate'; detail: Record<string, unknown> }>
  /** The next rotation fails like this. */
  failRotation(kind: 'broken' | 'transient' | null): void
  /** The next createApp throws. */
  failCreate(error: Error | null): void
  /** Holds rotations until the returned function is called. */
  holdRotations(): () => void
}

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
  /** What the provisioner did, when the fake can create apps (`provisionFor`). */
  provisioner: FakeProvisioner
}

function fakeProvisioning(integrationProvider: string, fake: FakeProvisioner & { rotationFailure: 'broken' | 'transient' | null; createFailure: Error | null; held: Promise<void> | null }): AgentIdentityProvisioning<FakeProvisioningCredentials> {
  let apps = 0
  const record = (op: FakeProvisioner['calls'][number]['op'], detail: Record<string, unknown>) => fake.calls.push({ op, detail })
  const describe = (input: Partial<AgentAppIdentity>) => ({ ...input, icon: input.icon ? input.icon.length : undefined })
  return {
    integrationProvider,
    info: { description: 'Creates agents’ apps, for tests.', fields: [{ key: 'key', label: 'Key', secret: true }], steps: ['Paste a key.'] },
    credentialsSchema: provisioningSchema,
    async verify(credentials) {
      if (credentials.key === 'bad') throw new DirectoryConnectError('That key is no good')
      return { ...credentials, generation: credentials.generation + 1, expiresAt: Date.now() + 12 * 60 * 60_000 }
    },
    needsRotation: (credentials, now) => credentials.expiresAt === undefined || credentials.expiresAt - now < 60 * 60_000,
    async rotate(credentials) {
      record('rotate', { generation: credentials.generation })
      if (fake.held) await fake.held
      const failure = fake.rotationFailure
      fake.rotationFailure = null
      if (failure === 'broken') throw new ProvisioningCredentialsError('The fake chain is broken')
      if (failure === 'transient') throw new Error('The fake provider is down')
      return { ...credentials, generation: credentials.generation + 1, expiresAt: Date.now() + 12 * 60 * 60_000 }
    },
    open(credentials) {
      return {
        async createApp(input) {
          record('create', { ...describe(input), webhookUrl: input.webhookUrl, redirectUrl: input.redirectUrl, generation: credentials.generation })
          if (fake.createFailure) {
            const error = fake.createFailure
            fake.createFailure = null
            throw error
          }
          const appId = `APP${++apps}`
          return {
            app: { appId, clientSecret: `secret-${appId}` },
            config: { signingSecret: `signing-${appId}` },
            installUrl: `https://provider.test/install?client_id=${appId}`,
            verification: { algorithm: 'hmac-sha256', encoding: 'hex', header: 'x-signature', template: '{body}', secret: `signing-${appId}` },
            iconSet: !!input.icon,
            settingsUrl: `https://provider.test/apps/${appId}`,
          }
        },
        async completeInstall(app: ProvisionedAppRecord, code, redirectUrl) {
          record('install', { appId: app.appId, code, redirectUrl })
          return { botToken: `token-${String(app.appId)}-${code}` }
        },
        async deleteApp(app) { record('delete', { appId: app.appId }) },
        async updateApp(app, input) {
          record('update', { appId: app.appId, ...describe(input) })
          return input.icon ? { iconSet: true } : {}
        },
      }
    },
  }
}

export function createFakeDirectoryProvider(id = 'fake', label = 'Fake Directory', options: { provisionFor?: string } = {}): FakeDirectory {
  const people = new Map<string, DirectoryUser[]>()
  const failures = new Map<string, Error>()
  let held: Promise<void> | null = null
  const provisioner = {
    calls: [] as FakeProvisioner['calls'],
    rotationFailure: null as 'broken' | 'transient' | null,
    createFailure: null as Error | null,
    held: null as Promise<void> | null,
    failRotation(kind: 'broken' | 'transient' | null) { provisioner.rotationFailure = kind },
    failCreate(error: Error | null) { provisioner.createFailure = error },
    holdRotations() {
      let release!: () => void
      provisioner.held = new Promise((resolve) => { release = resolve })
      return () => { provisioner.held = null; release() }
    },
  }
  const fake: FakeDirectory = {
    provisioner,
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
      ...(options.provisionFor ? { provisioning: fakeProvisioning(options.provisionFor, provisioner) } : {}),
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

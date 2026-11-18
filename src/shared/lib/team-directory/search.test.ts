import { describe, expect, it } from 'vitest'
import { filterDirectoryPeople, matchRank, mergeDirectoryPeople } from './search'
import type { DirectoryUser } from './types'

const person = (provider: string, remoteId: string, name: string, email?: string, extra: Partial<DirectoryUser> = {}): DirectoryUser => ({
  provider, tenantId: `${provider}-tenant`, remoteId, name, ...(email ? { email } : {}), emailVerified: !!email, ...extra,
})

describe('mergeDirectoryPeople', () => {
  it('shows a person in several directories once, named by the first directory that lists them', () => {
    const merged = mergeDirectoryPeople([
      { directoryId: 'd1', directoryLabel: 'Slack · Acme', users: [person('slack', 'U1', 'Dana W.', 'Dana@Acme.test')] },
      { directoryId: 'd2', directoryLabel: 'Fake · Acme', users: [person('fake', 'f-9', 'Dana Whitfield', 'dana@acme.test ', { avatarUrl: 'https://img.test/dana.png' })] },
    ])
    expect(merged).toEqual([{
      name: 'Dana W.',
      email: 'dana@acme.test',
      avatarUrl: 'https://img.test/dana.png',
      sources: [
        { directoryId: 'd1', directoryLabel: 'Slack · Acme', provider: 'slack', tenantId: 'slack-tenant', remoteId: 'U1' },
        { directoryId: 'd2', directoryLabel: 'Fake · Acme', provider: 'fake', tenantId: 'fake-tenant', remoteId: 'f-9' },
      ],
    }])
  })

  it('never merges, or lists, a person whose email no directory verified', () => {
    const merged = mergeDirectoryPeople([
      { directoryId: 'd1', directoryLabel: 'A', users: [
        person('fake', '1', 'Verified Vic', 'vic@acme.test'),
        person('fake', '2', 'Claimed Vic', 'vic2@acme.test', { emailVerified: false }),
        person('fake', '3', 'No Email'),
      ] },
      { directoryId: 'd2', directoryLabel: 'B', users: [person('fake', '4', 'Impostor', 'vic@acme.test', { emailVerified: false })] },
    ])
    expect(merged.map((p) => [p.name, p.sources.map((s) => s.remoteId)])).toEqual([['Verified Vic', ['1']]])
  })

  it('lists a person a directory repeats once', () => {
    const dana = person('fake', 'U1', 'Dana', 'dana@acme.test')
    expect(mergeDirectoryPeople([{ directoryId: 'd1', directoryLabel: 'A', users: [dana, dana] }])[0].sources).toHaveLength(1)
  })
})

describe('filterDirectoryPeople', () => {
  const people = mergeDirectoryPeople([{ directoryId: 'd1', directoryLabel: 'A', users: [
    person('fake', '1', 'Sara Kim', 'sara@acme.test'),
    person('fake', '2', 'Dana Whitfield', 'dana@acme.test'),
    person('fake', '3', 'Adam Danes', 'adam@acme.test'),
    person('fake', '4', 'Bob Jordan', 'bdan@acme.test'),
  ] }])

  it('ranks name prefixes, then word or email prefixes, then anything containing the query', () => {
    expect(filterDirectoryPeople(people, 'dan', 10).map((p) => p.name)).toEqual(['Dana Whitfield', 'Adam Danes', 'Bob Jordan'])
  })

  it('returns everyone by name for an empty query, up to the limit', () => {
    expect(filterDirectoryPeople(people, '', 3).map((p) => p.name)).toEqual(['Adam Danes', 'Bob Jordan', 'Dana Whitfield'])
  })

  it('matches emails, case-insensitively', () => {
    expect(matchRank('SARA@', { name: 'Sara Kim', email: 'sara@acme.test' })).toBe(1)
    expect(matchRank('zed', { name: 'Sara Kim', email: 'sara@acme.test' })).toBeNull()
  })
})

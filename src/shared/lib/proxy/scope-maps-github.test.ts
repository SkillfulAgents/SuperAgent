import { describe, expect, it } from 'vitest'
import { isValidApiScope, matchScopes } from './scope-matcher'
import { getScopeLabel } from './scope-metadata'
import { SCOPE_MAPS } from './scope-maps'

describe('GitHub Checks permissions', () => {
  // Both classic repo access and the fine-grained Checks permissions suffice:
  // https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps#repository-permissions-for-checks
  it.each([
    '/repos/SkillfulAgents/iOS-App/check-runs/123',
    '/repos/SkillfulAgents/iOS-App/check-suites/456',
    '/repos/SkillfulAgents/iOS-App/check-suites/456/check-runs',
    '/repos/SkillfulAgents/iOS-App/commits/126311d90f14c14e7ca8a69f1753242a272ad5c7/check-runs',
    '/repos/SkillfulAgents/iOS-App/commits/main/check-suites',
  ])('includes every sufficient permission for GET %s', (path) => {
    const result = matchScopes('github', 'GET', path)

    expect(result.matched).toBe(true)
    expect(result.scopes).toEqual(['repo', 'checks:read', 'checks:write'])
    expect(result.scopes.map((scope) => getScopeLabel('github', scope)))
      .toEqual(['destructive', 'read', 'write'])
    for (const scope of result.scopes) {
      expect(isValidApiScope('github', scope)).toBe(true)
      expect(result.descriptions[scope]).toBeTruthy()
    }
  })

  it.each([
    ['POST', '/repos/SkillfulAgents/iOS-App/check-runs'],
    ['PATCH', '/repos/SkillfulAgents/iOS-App/check-runs/123'],
    ['POST', '/repos/SkillfulAgents/iOS-App/check-runs/123/rerequest'],
    ['POST', '/repos/SkillfulAgents/iOS-App/check-suites'],
    ['PATCH', '/repos/SkillfulAgents/iOS-App/check-suites/preferences'],
    ['POST', '/repos/SkillfulAgents/iOS-App/check-suites/456/rerequest'],
    ['DELETE', '/repos/SkillfulAgents/iOS-App'],
  ])('does not authorize %s %s with Checks read access', (method, path) => {
    expect(matchScopes('github', method, path).scopes).not.toContain('checks:read')
  })
})

describe('GitHub sufficient-scope audit', () => {
  // Representative reads from each permission family. Test the actual matcher,
  // including more-specific rows that could otherwise hide a corrected mapping.
  it.each([
    ['/repos/acme/app', 'metadata'],
    ['/repos/acme/app/contents/README.md', 'contents'],
    ['/repos/acme/app/compare/main...feature', 'contents'],
    ['/repos/acme/app/git/matching-refs', 'contents'],
    ['/repos/acme/app/git/matching-refs/heads', 'contents'],
    ['/repos/acme/app/issues', 'issues'],
    ['/repos/acme/app/pulls/42/files', 'pull_requests'],
    ['/repos/acme/app/actions/runs', 'actions'],
    ['/repos/acme/app/actions/artifacts/123/zip', 'actions'],
    ['/repos/acme/app/deployments', 'deployments'],
    ['/repos/acme/app/commits/main/status', 'statuses'],
    ['/repos/acme/app/branches/main/protection', 'administration'],
    ['/repos/acme/app/hooks', 'repository_hooks'],
    ['/repos/acme/app/actions/secrets', 'secrets'],
    ['/repos/acme/app/code-scanning/alerts', 'security_events'],
    ['/repos/acme/app/secret-scanning/alerts', 'secret_scanning_alerts'],
    ['/orgs/acme/members', 'members'],
    ['/orgs/acme/hooks', 'organization_hooks'],
    ['/user/emails', 'emails'],
    ['/user/followers', 'followers'],
    ['/user/keys', 'keys'],
    ['/user/gpg_keys', 'gpg_keys'],
    ['/user/ssh_signing_keys', 'git_signing_ssh_public_keys'],
    ['/user/starred', 'starring'],
  ])('allows GET %s with %s read permission', (path, permission) => {
    const result = matchScopes('github', 'GET', path)
    expect(result.matched).toBe(true)
    expect(result.scopes).toContain(`${permission}:read`)
    expect(getScopeLabel('github', `${permission}:read`)).toBe('read')
    if (permission !== 'metadata') expect(result.scopes).toContain(`${permission}:write`)
  })

  it.each([
    ['GET', '/repos/acme/app/issues/42/comments', ['issues:read', 'issues:write', 'pull_requests:read', 'pull_requests:write']],
    ['POST', '/repos/acme/app/issues/42/comments', ['issues:write', 'pull_requests:write']],
    ['GET', '/repos/acme/app/pulls/42', ['pull_requests:read', 'pull_requests:write', 'contents:read', 'contents:write']],
    ['POST', '/user/repos', ['administration:write', 'repository_creation:write']],
    ['POST', '/orgs/acme/repos', ['administration:write', 'repository_creation:write']],
    ['GET', '/repos/acme/app/invitations', ['administration:read', 'administration:write', 'private_repository_invitations:read']],
    ['GET', '/repos/acme/app/stargazers', ['metadata:read', 'contents:write']],
  ])('keeps all independent alternatives for %s %s', (method, path, scopes) => {
    expect(matchScopes('github', method, path).scopes).toEqual(expect.arrayContaining(scopes))
  })

  it.each([
    ['GET', '/orgs/acme/memberships/alice', ['read:org', 'write:org', 'admin:org']],
    ['GET', '/orgs/acme/teams/platform/repos', ['read:org', 'write:org', 'admin:org', 'repo']],
    ['GET', '/user/teams', ['read:org', 'write:org', 'admin:org', 'user', 'repo']],
    ['GET', '/repos/acme/app/hooks', ['read:repo_hook', 'write:repo_hook', 'admin:repo_hook', 'repo', 'public_repo']],
    ['POST', '/repos/acme/app/hooks/123/pings', ['read:repo_hook', 'write:repo_hook', 'admin:repo_hook', 'repo', 'public_repo']],
    ['GET', '/user/keys', ['read:public_key', 'write:public_key', 'admin:public_key']],
    ['GET', '/user/gpg_keys', ['read:gpg_key', 'write:gpg_key', 'admin:gpg_key']],
    ['GET', '/user/ssh_signing_keys', ['read:ssh_signing_key', 'write:ssh_signing_key', 'admin:ssh_signing_key']],
    ['GET', '/notifications', ['notifications', 'repo']],
    ['GET', '/user/emails', ['user:email', 'user']],
    ['GET', '/repos/acme/app/deployments', ['repo_deployment', 'repo', 'public_repo']],
    ['GET', '/repos/acme/app/commits/main/status', ['repo:status', 'repo', 'public_repo']],
  ])('includes classic scope alternatives for %s %s', (method, path, scopes) => {
    expect(matchScopes('github', method, path).scopes).toEqual(expect.arrayContaining(scopes))
  })

  it.each([
    ['POST', '/repos/acme/app/forks', ['administration:write', 'repository_creation:write', 'contents:read']],
    ['PUT', '/orgs/acme/teams/platform/repos/acme/app', ['administration:write', 'members:read']],
    ['DELETE', '/orgs/acme/teams/platform/repos/acme/app', ['administration:write', 'members:read']],
    ['PUT', '/user/starred/acme/app', ['starring:write', 'metadata:read']],
    ['DELETE', '/user/starred/acme/app', ['starring:write', 'metadata:read']],
  ])('does not flatten required combinations into alternatives for %s %s', (method, path, partialScopes) => {
    const result = matchScopes('github', method, path)
    expect(result.matched).toBe(true)
    for (const scope of partialScopes) expect(result.scopes).not.toContain(scope)
  })

  it('requires Contents write to merge; Pull requests write alone is insufficient', () => {
    const { scopes } = matchScopes('github', 'PUT', '/repos/acme/app/pulls/42/merge')
    expect(scopes).toContain('contents:write')
    expect(scopes).not.toContain('pull_requests:write')
  })

  it('does not treat additional Workflows access as sufficient for content changes', () => {
    for (const entry of SCOPE_MAPS.github.scopeMap) {
      expect(entry.sufficientScopes).not.toContain('workflows:write')
    }
  })

  it('only allows fine-grained read access on non-GET requests for documented webhook ping/test calls', () => {
    for (const entry of SCOPE_MAPS.github.scopeMap.filter((entry) => entry.method !== 'GET')) {
      // GitHub deliberately includes ping/test calls in repository webhook read access.
      const expected = entry.method === 'POST' && ['/repos/*/*/hooks/*/pings', '/repos/*/*/hooks/*/tests'].includes(entry.pathPattern)
        ? ['repository_hooks:read'] : []
      expect(entry.sufficientScopes.filter((scope) => scope.endsWith(':read')), `${entry.method} ${entry.pathPattern}`).toEqual(expected)
    }
  })

  it('declares and describes every sufficient scope without duplicates', () => {
    for (const entry of SCOPE_MAPS.github.scopeMap) {
      expect(new Set(entry.sufficientScopes).size).toBe(entry.sufficientScopes.length)
      for (const scope of entry.sufficientScopes) {
        expect(isValidApiScope('github', scope), scope).toBe(true)
        expect(getScopeLabel('github', scope), scope).toBeTruthy()
      }
    }
  })

  it('uses the documented workflow dispatch method and removes the nonexistent issue-assignees read', () => {
    expect(matchScopes('github', 'POST', '/repos/acme/app/actions/workflows/ci.yml/dispatches').scopes).toContain('actions:write')
    expect(matchScopes('github', 'PUT', '/repos/acme/app/actions/workflows/ci.yml/dispatches').matched).toBe(false)
    expect(matchScopes('github', 'GET', '/repos/acme/app/issues/42/assignees').matched).toBe(false)
  })
})

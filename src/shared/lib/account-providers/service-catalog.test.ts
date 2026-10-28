import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { getToolkitSlugFromProviderSlug, getProviderSlug, getProvider, isProviderSupported, SUPPORTED_PROVIDERS } from './service-catalog'

// The container ships separately, so its catalog cannot import host code. Read
// its literal catalog without loading the container SDK into the host suite.
function agentCatalog(name: 'ALL_SERVICES' | 'GAMUT_PLATFORM_ACCOUNTS') {
  const filename = path.resolve(__dirname, '../../../../agent-container/src/tools/search-connected-account-services.ts')
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((item) => ts.isIdentifier(item.name) && item.name.text === name)
  if (!declaration?.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) {
    throw new Error(`Missing literal agent catalog: ${name}`)
  }
  return declaration.initializer.elements.map((element) => {
    if (!ts.isObjectLiteralExpression(element)) throw new Error('Expected a service object')
    const fields: Record<string, string> = {}
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || !ts.isStringLiteral(property.initializer)) {
        throw new Error('Expected literal service metadata')
      }
      fields[property.name.text] = property.initializer.text
    }
    return { slug: fields.slug, displayName: fields.displayName, description: fields.description }
  })
}

describe('host and agent account catalogs', () => {
  it.each([false, true])('exposes the same account types and descriptions with platform mode %s', (platformMode) => {
    const host = SUPPORTED_PROVIDERS
      .filter((provider) => !provider.unlisted && (!provider.platformOnly || platformMode))
      .map(({ slug, displayName, description }) => ({ slug, displayName, description }))
    const agent = [...agentCatalog('ALL_SERVICES'), ...(platformMode ? agentCatalog('GAMUT_PLATFORM_ACCOUNTS') : [])]
    const bySlug = (a: { slug: string }, b: { slug: string }) => a.slug.localeCompare(b.slug)
    expect(agent.sort(bySlug)).toEqual(host.sort(bySlug))
    expect(new Set(agent.map((service) => service.slug)).size).toBe(agent.length)
  })

  it('keeps toolkit mappings unambiguous', () => {
    const slugs = SUPPORTED_PROVIDERS.map((provider) => provider.slug)
    const composioSlugs = SUPPORTED_PROVIDERS.map((provider) => provider.composioSlug)
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(new Set(composioSlugs).size).toBe(composioSlugs.length)
  })
})

describe('getToolkitSlugFromProviderSlug', () => {
  it('maps nango slug back to toolkit slug', () => {
    expect(getToolkitSlugFromProviderSlug('google-mail', 'nango')).toBe('gmail')
    expect(getToolkitSlugFromProviderSlug('google-calendar', 'nango')).toBe('googlecalendar')
  })

  it('maps composio slug back to toolkit slug', () => {
    expect(getToolkitSlugFromProviderSlug('gmail', 'composio')).toBe('gmail')
    expect(getToolkitSlugFromProviderSlug('slack', 'composio')).toBe('slack')
  })

  it('maps the bridge-hosted custom_plaid toolkit to plaid and back', () => {
    expect(getToolkitSlugFromProviderSlug('custom_plaid', 'composio')).toBe('plaid')
    expect(getProviderSlug('plaid', 'composio')).toBe('custom_plaid')
    expect(isProviderSupported('plaid', 'composio')).toBe(true)
    expect(isProviderSupported('plaid', 'nango')).toBe(false)
  })

  it('returns undefined for unknown provider slug', () => {
    expect(getToolkitSlugFromProviderSlug('nonexistent-service', 'nango')).toBeUndefined()
    expect(getToolkitSlugFromProviderSlug('nonexistent-service', 'composio')).toBeUndefined()
  })

  it('round-trips with getProviderSlug', () => {
    const toolkitSlug = 'gmail'
    const nangoSlug = getProviderSlug(toolkitSlug, 'nango')
    expect(getToolkitSlugFromProviderSlug(nangoSlug, 'nango')).toBe(toolkitSlug)

    const composioSlug = getProviderSlug(toolkitSlug, 'composio')
    expect(getToolkitSlugFromProviderSlug(composioSlug, 'composio')).toBe(toolkitSlug)
  })
})

describe('getProvider', () => {
  it('finds a provider by slug', () => {
    const p = getProvider('gmail')
    expect(p).toBeDefined()
    expect(p!.displayName).toBe('Gmail')
  })

  it('returns undefined for unknown slug', () => {
    expect(getProvider('nonexistent')).toBeUndefined()
  })
})

describe('isProviderSupported', () => {
  it('returns true for a supported provider', () => {
    expect(isProviderSupported('gmail')).toBe(true)
    expect(isProviderSupported('gmail', 'composio')).toBe(true)
  })

  it('returns false for an unsupported provider-specific slug', () => {
    const p = getProvider('gmail')
    if (p && !p.nangoSlug) {
      expect(isProviderSupported('gmail', 'nango')).toBe(false)
    }
  })

  it('returns false for unknown slug', () => {
    expect(isProviderSupported('nonexistent')).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { isHostAllowed, TOOLKIT_ALLOWED_HOSTS } from './allowed-hosts'
import { SUPPORTED_PROVIDERS } from '@shared/lib/composio/providers'

describe('isHostAllowed', () => {
  it('allows known hosts for gmail toolkit', () => {
    expect(isHostAllowed('gmail', 'gmail.googleapis.com')).toBe(true)
    expect(isHostAllowed('gmail', 'www.googleapis.com')).toBe(true)
  })

  it('rejects unknown hosts for gmail toolkit', () => {
    expect(isHostAllowed('gmail', 'evil.com')).toBe(false)
    expect(isHostAllowed('gmail', 'api.github.com')).toBe(false)
  })

  it('allows github api host for github toolkit', () => {
    expect(isHostAllowed('github', 'api.github.com')).toBe(true)
  })

  it('rejects unknown hosts for github toolkit', () => {
    expect(isHostAllowed('github', 'github.com')).toBe(false)
  })

  it('rejects all hosts for unknown toolkit', () => {
    expect(isHostAllowed('unknown_toolkit', 'anything.com')).toBe(false)
  })

  it('handles slack toolkit', () => {
    expect(isHostAllowed('slack', 'slack.com')).toBe(true)
    expect(isHostAllowed('slack', 'api.slack.com')).toBe(false)
  })

  it('handles twitter toolkit with both domains', () => {
    expect(isHostAllowed('twitter', 'api.twitter.com')).toBe(true)
    expect(isHostAllowed('twitter', 'api.x.com')).toBe(true)
    expect(isHostAllowed('twitter', 'twitter.com')).toBe(false)
  })

  describe('wildcard matching', () => {
    it('matches subdomains for jira (*.atlassian.net)', () => {
      expect(isHostAllowed('jira', 'myorg.atlassian.net')).toBe(true)
      expect(isHostAllowed('jira', 'company.atlassian.net')).toBe(true)
    })

    it('rejects bare domain for wildcard pattern', () => {
      expect(isHostAllowed('jira', 'atlassian.net')).toBe(false)
    })

    it('matches subdomains for salesforce (*.my.salesforce.com)', () => {
      expect(isHostAllowed('salesforce', 'acme.my.salesforce.com')).toBe(true)
      expect(isHostAllowed('salesforce', 'test.salesforce.com')).toBe(true)
    })

    it('matches subdomains for zendesk (*.zendesk.com)', () => {
      expect(isHostAllowed('zendesk', 'mycompany.zendesk.com')).toBe(true)
      expect(isHostAllowed('zendesk', 'zendesk.com')).toBe(false)
    })

    it('matches subdomains for shopify (*.myshopify.com)', () => {
      expect(isHostAllowed('shopify', 'mystore.myshopify.com')).toBe(true)
      expect(isHostAllowed('shopify', 'myshopify.com')).toBe(false)
    })

    it('matches subdomains for mailchimp (*.api.mailchimp.com)', () => {
      expect(isHostAllowed('mailchimp', 'us1.api.mailchimp.com')).toBe(true)
      expect(isHostAllowed('mailchimp', 'api.mailchimp.com')).toBe(false)
    })

    it('rejects unrelated hosts for wildcard toolkits', () => {
      expect(isHostAllowed('jira', 'evil.com')).toBe(false)
      expect(isHostAllowed('salesforce', 'evil.salesforce.com.evil.com')).toBe(
        false
      )
    })
  })

  it('allowed-hosts has an entry for every provider in providers.ts', () => {
    const providerSlugs = SUPPORTED_PROVIDERS.map((p) => p.slug)
    for (const slug of providerSlugs) {
      expect(
        TOOLKIT_ALLOWED_HOSTS[slug],
        `allowed-hosts.ts is missing entry for provider "${slug}"`
      ).toBeDefined()
      expect(TOOLKIT_ALLOWED_HOSTS[slug].length).toBeGreaterThan(0)
    }
  })

  it('allowed-hosts has no extra slugs beyond providers.ts', () => {
    const providerSlugs = new Set(SUPPORTED_PROVIDERS.map((p) => p.slug))
    for (const key of Object.keys(TOOLKIT_ALLOWED_HOSTS)) {
      expect(
        providerSlugs.has(key),
        `allowed-hosts.ts has key "${key}" not found in providers.ts`
      ).toBe(true)
    }
  })

  it('system-prompt.md lists exactly the same slugs as providers.ts', () => {
    const promptPath = resolve(__dirname, '../../../../agent-container/src/system-prompt.md')
    const promptContent = readFileSync(promptPath, 'utf-8')

    const slugRegex = /`([a-z][a-z0-9_]*)`/g
    const servicesLine = promptContent
      .split('\n')
      .find((line) => line.startsWith('**Supported services include:**'))
    expect(servicesLine, 'Could not find supported services line in system-prompt.md').toBeDefined()

    const promptSlugs = new Set<string>()
    let match: RegExpExecArray | null
    while ((match = slugRegex.exec(servicesLine!)) !== null) {
      promptSlugs.add(match[1])
    }

    const providerSlugs = new Set(SUPPORTED_PROVIDERS.map((p) => p.slug))

    for (const slug of providerSlugs) {
      expect(
        promptSlugs.has(slug),
        `system-prompt.md is missing slug "${slug}" from providers.ts`
      ).toBe(true)
    }
    for (const slug of promptSlugs) {
      expect(
        providerSlugs.has(slug),
        `system-prompt.md has slug "${slug}" not found in providers.ts`
      ).toBe(true)
    }
  })
})

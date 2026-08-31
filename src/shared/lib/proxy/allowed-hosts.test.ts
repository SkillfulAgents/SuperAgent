import { describe, it, expect } from 'vitest'
import { isHostAllowed, matchesHostPatterns, TOOLKIT_ALLOWED_HOSTS } from './allowed-hosts'

describe('matchesHostPatterns', () => {
  it('matches an exact host', () => {
    expect(matchesHostPatterns('api.github.com', ['api.github.com'])).toBe(true)
  })

  it('rejects a non-matching host', () => {
    expect(matchesHostPatterns('evil.com', ['api.github.com'])).toBe(false)
  })

  it('matches a subdomain for a *. wildcard', () => {
    expect(matchesHostPatterns('myorg.atlassian.net', ['*.atlassian.net'])).toBe(true)
  })

  it('rejects the bare domain for a *. wildcard', () => {
    expect(matchesHostPatterns('atlassian.net', ['*.atlassian.net'])).toBe(false)
  })

  it('rejects a suffix-spoof that is not a real subdomain', () => {
    expect(matchesHostPatterns('evil-atlassian.net', ['*.atlassian.net'])).toBe(false)
  })

  it('returns false for an empty pattern list', () => {
    expect(matchesHostPatterns('anything.com', [])).toBe(false)
  })

  it('matches when any pattern in the list matches', () => {
    expect(matchesHostPatterns('api.x.com', ['api.twitter.com', 'api.x.com'])).toBe(true)
  })
})

describe('isHostAllowed', () => {
  it('allows known hosts for gmail toolkit', () => {
    expect(isHostAllowed('gmail', 'gmail.googleapis.com')).toBe(true)
    expect(isHostAllowed('gmail', 'www.googleapis.com')).toBe(true)
  })

  it('rejects unknown hosts for gmail toolkit', () => {
    expect(isHostAllowed('gmail', 'evil.com')).toBe(false)
    expect(isHostAllowed('gmail', 'api.github.com')).toBe(false)
  })

  it('allows every github host the toolkit actually needs', () => {
    expect(isHostAllowed('github', 'api.github.com')).toBe(true)
    // github.com carries the git smart-HTTP transport, which api.github.com
    // does not serve — blocking it broke authenticated git access.
    expect(isHostAllowed('github', 'github.com')).toBe(true)
    expect(isHostAllowed('github', 'raw.githubusercontent.com')).toBe(true)
    expect(isHostAllowed('github', 'uploads.github.com')).toBe(true)
  })

  it('rejects unknown hosts for github toolkit', () => {
    expect(isHostAllowed('github', 'gist.github.com')).toBe(false)
    expect(isHostAllowed('github', 'evil-github.com')).toBe(false)
  })

  it('allows the git transport host for bitbucket', () => {
    expect(isHostAllowed('bitbucket', 'api.bitbucket.org')).toBe(true)
    expect(isHostAllowed('bitbucket', 'bitbucket.org')).toBe(true)
  })

  it('allows regional sentry hosts', () => {
    expect(isHostAllowed('sentry', 'sentry.io')).toBe(true)
    expect(isHostAllowed('sentry', 'us.sentry.io')).toBe(true)
    expect(isHostAllowed('sentry', 'de.sentry.io')).toBe(true)
    expect(isHostAllowed('sentry', 'evil-sentry.io')).toBe(false)
  })

  it('allows every datadog site host', () => {
    expect(isHostAllowed('datadog', 'api.datadoghq.com')).toBe(true)
    expect(isHostAllowed('datadog', 'api.datadoghq.eu')).toBe(true)
    expect(isHostAllowed('datadog', 'api.ap1.datadoghq.com')).toBe(true)
    expect(isHostAllowed('datadog', 'api.ddog-gov.com')).toBe(true)
  })

  it('allows the secondary upload and event hosts', () => {
    expect(isHostAllowed('pagerduty', 'events.pagerduty.com')).toBe(true)
    expect(isHostAllowed('linear', 'uploads.linear.app')).toBe(true)
    expect(isHostAllowed('airtable', 'content.airtable.com')).toBe(true)
    expect(isHostAllowed('stripe', 'files.stripe.com')).toBe(true)
    expect(isHostAllowed('twitter', 'upload.twitter.com')).toBe(true)
  })

  it('rejects all hosts for unknown toolkit', () => {
    expect(isHostAllowed('unknown_toolkit', 'anything.com')).toBe(false)
  })

  it('handles slack toolkit', () => {
    expect(isHostAllowed('slack', 'slack.com')).toBe(true)
    // files.slack.com serves private file downloads (SUP-303)
    expect(isHostAllowed('slack', 'files.slack.com')).toBe(true)
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

  it('has entries for all expected toolkits', () => {
    const expectedToolkits = [
      // Google Workspace
      'gmail',
      'googlecalendar',
      'googledrive',
      'googlesheets',
      'googledocs',
      'googleslides',
      'googlemeet',
      'googletasks',
      'youtube',
      // Microsoft
      'outlook',
      'microsoft_teams',
      // Communication
      'slack',
      'discord',
      // Developer Tools
      'github',
      'gitlab',
      'bitbucket',
      'sentry',
      'datadog',
      'pagerduty',
      // Project Management
      'notion',
      'linear',
      'jira',
      'confluence',
      'asana',
      'monday',
      'clickup',
      'trello',
      // CRM & Sales
      'hubspot',
      'salesforce',
      'pipedrive',
      'zendesk',
      'intercom',
      // Cloud Storage & Documents
      'airtable',
      'dropbox',
      'box',
      'docusign',
      // Social Media
      'twitter',
      'linkedin',
      'instagram',
      // E-Commerce & Finance
      'shopify',
      'stripe',
      'quickbooks',
      'xero',
      // Marketing
      'mailchimp',
      // Design
      'figma',
      // Scheduling & Forms
      'calendly',
      'typeform',
      // Video
      'zoom',
      // Communication (sales)
      'gong',
    ]
    for (const toolkit of expectedToolkits) {
      expect(TOOLKIT_ALLOWED_HOSTS[toolkit]).toBeDefined()
      expect(TOOLKIT_ALLOWED_HOSTS[toolkit].length).toBeGreaterThan(0)
    }
  })
})

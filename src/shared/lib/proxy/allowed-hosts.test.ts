import { describe, it, expect } from 'vitest'
import { isHostAllowed, matchesHostPatterns, TOOLKIT_ALLOWED_HOSTS } from './allowed-hosts'
import { SUPPORTED_PROVIDERS } from '../account-providers/service-catalog'

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

  it('matches any parsed hostname, so a block list still catches unusual ones', () => {
    expect(matchesHostPatterns('a_b.evil.com', ['*.evil.com'])).toBe(true)
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

  it('allows only Plaid API hosts for the plaid toolkit', () => {
    expect(isHostAllowed('plaid', 'production.plaid.com')).toBe(true)
    expect(isHostAllowed('plaid', 'sandbox.plaid.com')).toBe(true)
    expect(isHostAllowed('plaid', 'secure.plaid.com')).toBe(false)
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

  it('allows the discovery and API hosts needed by the expanded catalog', () => {
    const requests = [
      ['attio', 'api.attio.com'],
      ['basecamp', '3.basecampapi.com'],
      ['basecamp', 'launchpad.37signals.com'],
      ['dart', 'app.dartai.com'],
      ['google_analytics', 'analyticsdata.googleapis.com'],
      ['google_analytics', 'analyticsadmin.googleapis.com'],
      ['google_search_console', 'searchconsole.googleapis.com'],
      ['google_maps', 'places.googleapis.com'],
      ['google_maps', 'routes.googleapis.com'],
      ['googlesuper', 'gmail.googleapis.com'],
      ['one_drive', 'graph.microsoft.com'],
      ['excel', 'graph.microsoft.com'],
      ['jira', 'api.atlassian.com'],
      ['gong', 'company-17.api.gong.io'],
      ['share_point', 'contoso.sharepoint.com'],
      ['gorgias', 'acme.gorgias.com'],
      ['slackbot', 'files.slack.com'],
      ['notebook_lm', 'discoveryengine.googleapis.com'],
      ['fathom', 'fathom.video'],
      ['whatsapp', 'graph.facebook.com'],
      ['supabase', 'api.supabase.com'],
    ]
    for (const [toolkit, host] of requests) {
      expect(isHostAllowed(toolkit, host), `${toolkit}: ${host}`).toBe(true)
    }
  })

  it('supports explicit regional API hosts without granting arbitrary vendor subdomains', () => {
    const requests = [
      ['dynamics365', 'acme.api.crm8.dynamics.com'],
      ['dynamics365', 'acme.api.crm22.dynamics.com'],
      ['boldsign', 'api-eu.boldsign.com'],
      ['boldsign', 'api-ca.boldsign.com'],
      ['wrike', 'app-eu.wrike.com'],
      ['wrike', 'app-us2.wrike.com'],
      ['zoho', 'www.zohoapis.eu'],
      ['zoho_bigin', 'www.zohoapis.com.au'],
      ['zoho_books', 'www.zohoapis.com.cn'],
      ['zoho_inventory', 'www.zohoapis.sa'],
      ['zoho_invoice', 'www.zohoapis.ca'],
      ['zoho_mail', 'mail.zohocloud.ca'],
      ['zoho_desk', 'desk.zohocloud.ca'],
    ]
    for (const [toolkit, host] of requests) {
      expect(isHostAllowed(toolkit, host), `${toolkit}: ${host}`).toBe(true)
    }
    expect(isHostAllowed('zoho', 'attacker.zohoapis.com')).toBe(false)
    expect(isHostAllowed('zoho_mail', 'accounts.zoho.com')).toBe(false)
    expect(isHostAllowed('google_analytics', 'storage.googleapis.com')).toBe(false)
    expect(isHostAllowed('googlesuper', 'storage.googleapis.com')).toBe(false)
    expect(isHostAllowed('supabase', 'attacker.supabase.co')).toBe(false)
    expect(isHostAllowed('dynamics365', 'acme.api.crm999.dynamics.com')).toBe(false)
    expect(isHostAllowed('gong', 'app.gong.io')).toBe(false)
    expect(isHostAllowed('share_point', 'graph.microsoft.com')).toBe(false)
  })

  it('rejects spoofed tenant hosts for newly supported services', () => {
    const tenantHosts = [
      ['gong', 'company-17.api.gong.io', 'api.gong.io'],
      ['share_point', 'contoso.sharepoint.com', 'sharepoint.com'],
      ['gorgias', 'acme.gorgias.com', 'gorgias.com'],
      ['dynamics365', 'acme.api.crm4.dynamics.com', 'api.crm4.dynamics.com'],
    ]
    for (const [toolkit, host, suffix] of tenantHosts) {
      for (const spoof of [
        `${host}.evil.com`, `evil-${suffix}`, `evil.com#.${suffix}`,
        `evil.com?.${suffix}`, `user@${host}`, `${host}:443`,
      ]) {
        expect(isHostAllowed(toolkit, spoof), `${toolkit}: ${spoof}`).toBe(false)
      }
    }
  })

  it('has an API host allowlist for every offered Composio account type', () => {
    for (const provider of SUPPORTED_PROVIDERS.filter((p) => p.composioSlug)) {
      expect(TOOLKIT_ALLOWED_HOSTS[provider.slug]?.length, provider.slug).toBeGreaterThan(0)
    }
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

  describe('host string validation', () => {
    // Each ends in `.atlassian.net`, but `https://<host>/` does not name that
    // host: the URL parser reads another host, or none at all.
    it.each([
      ['a fragment', 'evil.com#.atlassian.net'],
      ['a query', 'evil.com?.atlassian.net'],
      ['a backslash', 'evil.com\\.atlassian.net'],
      ['a slash', 'evil.com/.atlassian.net'],
      ['userinfo', 'user@evil.com.atlassian.net'],
      ['a port', 'evil.com:1.atlassian.net'],
      ['a tab', 'evil.com\t.atlassian.net'],
      ['a newline', 'evil.com\n.atlassian.net'],
      ['a space', 'evil.com .atlassian.net'],
      ['a percent-escape', 'evil.com%23.atlassian.net'],
      ['an escaped dot', 'evil%2ecom.atlassian.net'],
      ['brackets', '[::1].atlassian.net'],
      ['an empty label', 'acme..atlassian.net'],
      ['invalid punycode', 'xn--a.atlassian.net'],
    ])('rejects a host with %s', (_, host) => {
      expect(isHostAllowed('jira', host)).toBe(false)
    })

    it('rejects a port on an otherwise allowed host', () => {
      expect(isHostAllowed('github', 'api.github.com:443')).toBe(false)
      expect(isHostAllowed('jira', 'acme.atlassian.net:8443')).toBe(false)
    })

    it('ignores case, as DNS does', () => {
      expect(isHostAllowed('jira', 'Acme.atlassian.net')).toBe(true)
      expect(isHostAllowed('jira', 'ACME.ATLASSIAN.NET')).toBe(true)
      expect(isHostAllowed('github', 'API.GitHub.com')).toBe(true)
      expect(isHostAllowed('github', 'Evil-GitHub.com')).toBe(false)
      expect(isHostAllowed('jira', 'EVIL.COM#.ATLASSIAN.NET')).toBe(false)
    })

    it('rejects a non-ASCII letter that lowercases to an ASCII one', () => {
      // U+212A KELVIN SIGN lowercases to `k`.
      expect(isHostAllowed('jira', 'Kacme.atlassian.net')).toBe(false)
    })

    it('rejects a trailing dot', () => {
      expect(isHostAllowed('jira', 'acme.atlassian.net.')).toBe(false)
    })

    it('allows real subdomains with digits and inner hyphens', () => {
      expect(isHostAllowed('salesforce', 'acme--dev.sandbox.my.salesforce.com')).toBe(true)
      expect(isHostAllowed('mailchimp', 'us21.api.mailchimp.com')).toBe(true)
      expect(isHostAllowed('shopify', 'my-store-2.myshopify.com')).toBe(true)
    })

    it('allows every listed host and a subdomain of every wildcard', () => {
      for (const [toolkit, patterns] of Object.entries(TOOLKIT_ALLOWED_HOSTS)) {
        for (const pattern of patterns) {
          const host = pattern.startsWith('*.') ? `acme-1${pattern.slice(1)}` : pattern
          expect(isHostAllowed(toolkit, host), `${toolkit}: ${host}`).toBe(true)
        }
      }
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
      'highlevel',
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
      'canva',
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

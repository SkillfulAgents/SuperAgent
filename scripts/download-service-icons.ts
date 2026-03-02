/**
 * Downloads service icons from the Composio logos API.
 * Saves each as an individual SVG file in public/service-icons/{slug}.svg
 *
 * Usage: npx tsx scripts/download-service-icons.ts
 */

import { writeFileSync, mkdirSync } from 'fs'
import path from 'path'

const COMPOSIO_LOGOS_API = 'https://logos.composio.dev/api'
const OUTPUT_DIR = path.resolve(__dirname, '../src/renderer/public/service-icons')

// All unique slugs from providers.ts and common-servers.ts
const ALL_SLUGS = [
  // OAuth providers
  'gmail', 'googlecalendar', 'googledrive', 'googlesheets', 'googledocs',
  'googlemeet', 'googletasks', 'youtube', 'outlook', 'microsoftteams',
  'slack', 'discord', 'github', 'gitlab', 'bitbucket', 'sentry', 'datadog',
  'pagerduty', 'notion', 'linear', 'jira', 'confluence', 'asana', 'monday',
  'clickup', 'trello', 'hubspot', 'salesforce', 'pipedrive', 'zendesk',
  'intercom', 'airtable', 'dropbox', 'box', 'docusign', 'twitter',
  'linkedin', 'instagram', 'shopify', 'stripe', 'quickbooks', 'xero',
  'mailchimp', 'figma', 'calendly', 'typeform', 'zoom', 'gong',
  // MCP servers (unique ones not already above)
  'attio', 'close', 'atlassian', 'webflow', 'wix', 'granola', 'fireflies',
  'telnyx', 'dialer', 'vercel', 'cloudflare', 'netlify', 'neon', 'supabase',
  'buildkite', 'prisma', 'stackoverflow', 'semgrep', 'jam', 'grafbase',
  'socket', 'cortex', 'stytch', 'instantdb', 'paypal', 'square', 'plaid',
  'ramp', 'morningstar', 'dodo-payments', 'mercadolibre', 'mercadopago',
  'amplitude', 'ahrefs', 'thoughtspot', 'meta-ads', 'octagon', 'egnyte',
  'canva', 'cloudinary', 'invideo', 'exa', 'jina', 'apify', 'deepwiki',
  'huggingface', 'aws-knowledge', 'context7', 'microsoft-learn', 'tally',
  'zapier', 'pipedream', 'composio', 'make', 'waystation', 'indeed',
  'backdocket', 'peek', 'ean-search', 'supermemory', 'globalping', 'short-io',
]

// Slugs that share an icon with another service (saved under each slug's own filename)
const SHARED_ICON_SLUGS: Record<string, string> = {
  'cloudflare-docs': 'cloudflare',
  'cloudflare-workers': 'cloudflare',
  'cloudflare-observability': 'cloudflare',
  'cloudflare-radar': 'cloudflare',
}

// Slugs that don't match the Composio API name directly
const SLUG_TO_API_NAME: Record<string, string> = {
  'atlassian': 'jira',
  'microsoftteams': 'microsoft-teams',
  'googlecalendar': 'google-calendar',
  'googledrive': 'google-drive',
  'googlesheets': 'google-sheets',
  'googledocs': 'google-docs',
  'googlemeet': 'google-meet',
  'googletasks': 'google-tasks',
  'dodo-payments': 'dodo',
  'aws-knowledge': 'aws',
  'microsoft-learn': 'microsoft',
  'meta-ads': 'meta',
  'ean-search': 'ean',
  'short-io': 'short',
  'stackoverflow': 'stack-overflow',
  'mercadolibre': 'mercado-libre',
  'mercadopago': 'mercado-pago',
  'huggingface': 'hugging-face',
  'pagerduty': 'pager-duty',
  'quickbooks': 'quick-books',
}

function normalizeSvg(svg: string): string {
  return svg
    // Remove fixed width/height only from the root <svg> element (not child elements like <rect>)
    .replace(/(<svg\b[^>]*?)\s+width="[^"]*"/i, '$1')
    .replace(/(<svg\b[^>]*?)\s+height="[^"]*"/i, '$1')
    // Security: strip script tags and event handlers
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\bon\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\bon\w+\s*=\s*'[^']*'/gi, '')
    .trim()
}

async function fetchSvg(apiName: string): Promise<string | null> {
  try {
    const res = await fetch(`${COMPOSIO_LOGOS_API}/${apiName}`)
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('svg')) return null
    const svg = await res.text()
    if (!svg.includes('<svg')) return null
    return normalizeSvg(svg)
  } catch {
    return null
  }
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true })

  const allSlugs = [
    ...ALL_SLUGS,
    ...Object.keys(SHARED_ICON_SLUGS),
  ]

  // Deduplicate API names to avoid redundant fetches
  const apiNameToSlugs = new Map<string, string[]>()
  for (const slug of allSlugs) {
    const apiName = SHARED_ICON_SLUGS[slug] || SLUG_TO_API_NAME[slug] || slug
    if (!apiNameToSlugs.has(apiName)) {
      apiNameToSlugs.set(apiName, [])
    }
    apiNameToSlugs.get(apiName)!.push(slug)
  }

  const succeeded: string[] = []
  const failed: string[] = []

  // Fetch in batches
  const entries = [...apiNameToSlugs.entries()]
  const BATCH_SIZE = 10

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map(async ([apiName, slugs]) => {
        // Try the mapped name first, then slug as-is if different
        let svg = await fetchSvg(apiName)

        // If mapped name failed, try slug directly (for cases where our mapping is wrong)
        if (!svg && slugs.length === 1 && slugs[0] !== apiName) {
          svg = await fetchSvg(slugs[0])
        }

        return { apiName, slugs, svg }
      })
    )

    for (const { slugs, svg } of results) {
      if (svg) {
        for (const slug of slugs) {
          writeFileSync(path.join(OUTPUT_DIR, `${slug}.svg`), svg, 'utf-8')
          succeeded.push(slug)
        }
      } else {
        failed.push(...slugs)
      }
    }

    // Brief pause between batches to be polite
    if (i + BATCH_SIZE < entries.length) {
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  console.log(`\nDownloaded ${succeeded.length} icons to ${OUTPUT_DIR}`)

  if (failed.length > 0) {
    console.warn(`\nFailed to fetch ${failed.length} icons:`)
    for (const f of failed) {
      const mapping = SHARED_ICON_SLUGS[f] || SLUG_TO_API_NAME[f]
      console.warn(`  - ${f}${mapping ? ` (tried: ${mapping})` : ''}`)
    }
    console.warn('\nThese services will show a generic icon. Add SVGs manually later.')
  }
}

main()

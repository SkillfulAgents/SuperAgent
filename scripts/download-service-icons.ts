/**
 * Downloads service icons from Composio, with official sources for known mismatches.
 * Saves each as an individual SVG file in public/service-icons/{slug}.svg
 *
 * Usage: npx tsx scripts/download-service-icons.ts [--only-missing] [slug ...]
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import path from 'path'
import { unzipSync } from 'fflate'
import { optimizeServiceIcon } from './lib/optimize-service-icon'
import { SUPPORTED_PROVIDERS } from '../src/shared/lib/account-providers/service-catalog'

const COMPOSIO_LOGOS_API = 'https://logos.composio.dev/api'
const OUTPUT_DIR = path.resolve(__dirname, '../src/renderer/public/service-icons')

// Connected-account slugs come from the catalog; these additional icons serve
// MCP servers and previously connected services that remain usable.
const OTHER_SLUGS = [
  'datadog', 'pipedrive', 'docusign',
  'attio', 'close', 'atlassian', 'webflow', 'wix', 'granola', 'fireflies',
  'telnyx', 'dialer', 'vercel', 'cloudflare', 'netlify', 'neon', 'supabase',
  'buildkite', 'prisma', 'stackoverflow', 'semgrep', 'jam', 'grafbase',
  'socket', 'cortex', 'stytch', 'instantdb', 'paypal', 'square', 'plaid',
  'ramp', 'morningstar', 'dodo-payments', 'mercadolibre', 'mercadopago',
  'amplitude', 'ahrefs', 'thoughtspot', 'meta-ads', 'octagon', 'egnyte',
  'canva', 'cloudinary', 'invideo', 'exa', 'jina', 'apify', 'deepwiki',
  'huggingface', 'context7', 'microsoft-learn', 'tally',
  'zapier', 'pipedream', 'composio', 'make', 'waystation', 'indeed',
  'backdocket', 'peek', 'ean-search', 'supermemory', 'globalping', 'short-io',
]

// Slugs that share an icon with another service (saved under each slug's own filename)
const SHARED_ICON_SLUGS: Record<string, string> = {
  // Both Meta Ads rows share one mark. The logo source has no Meta glyph, so the
  // Facebook mark stands in for it.
  'meta-ads-official': 'facebook',
  'cloudflare-docs': 'cloudflare',
  'cloudflare-workers': 'cloudflare',
  'cloudflare-observability': 'cloudflare',
  'cloudflare-radar': 'cloudflare',
}

// Slugs that don't match the Composio API name directly. (The Teams mark is served
// under 'microsoft_teams' as-is; 'microsoft-teams' returns the grey placeholder.)
const SLUG_TO_API_NAME: Record<string, string> = {
  'atlassian': 'jira',
  'googlecalendar': 'google-calendar',
  'googledrive': 'google-drive',
  'googlesheets': 'google-sheets',
  'googledocs': 'google-docs',
  'googlemeet': 'google-meet',
  'googletasks': 'google-tasks',
  'dodo-payments': 'dodo',
  'microsoft-learn': 'microsoft',
  'meta-ads': 'facebook',
  'ean-search': 'ean',
  'short-io': 'short',
  'stackoverflow': 'stack-overflow',
  'mercadolibre': 'mercado-libre',
  'mercadopago': 'mercado-pago',
  'huggingface': 'hugging-face',
  'pagerduty': 'pager-duty',
  'quickbooks': 'quick-books',
}

type OfficialIconSource = {
  url: string
  svgClass?: string
  archiveEntry?: string
}

// Composio sometimes serves a page illustration, corporate logo, or wordmark
// instead of the product icon. Keep these corrections reproducible from the
// vendors themselves; a failed official download must not restore a wrong mark.
const OFFICIAL_ICON_SOURCES: Record<string, OfficialIconSource> = {
  square: {
    url: 'https://squareup.com/us/en',
    svgClass: 'LogoJewel',
  },
  stack_exchange: {
    // The network's site-switcher icon is distinct from the Stack Overflow glyph.
    url: 'https://stackexchange.com/',
    svgClass: 'iconStackExchange',
  },
  share_point: {
    url: 'https://www.microsoft.com/content/dam/microsoft/bade/images/icons/en-us/m365-app-icons-fy26/SharePoint-Icon-FY26.svg',
  },
  dynamics365: {
    // Official pack linked from learn.microsoft.com/en-us/dynamics365/get-started/icons.
    url: 'https://download.microsoft.com/download/498606aa-6d27-4f13-aa5c-1401078c153b/Dynamics-365-icons-scalable.zip',
    archiveEntry: 'Dynamics 365 Product Family Icons/Dynamics365_scalable.svg',
  },
  pagerduty: {
    url: 'https://www.pagerduty.com/favicon/prod/icon.svg',
  },
}

function normalizeSvg(svg: string): string {
  const sanitized = svg
    // Inline HTML SVGs need an explicit namespace to render as standalone images.
    .replace(/<svg\b[^>]*>/i, (root) => /\bxmlns=/.test(root)
      ? root
      : root.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"'))
    // Preserve the coordinate system of logos that supply only pixel sizes.
    .replace(/<svg\b[^>]*>/i, (root) => {
      if (/\bviewBox=/.test(root)) return root
      const width = root.match(/\bwidth="(\d+(?:\.\d+)?)(?:px)?"/)?.[1]
      const height = root.match(/\bheight="(\d+(?:\.\d+)?)(?:px)?"/)?.[1]
      return width && height
        ? root.replace(/>$/, ` viewBox="0 0 ${width} ${height}">`)
        : root
    })
    // Remove fixed width/height only from the root <svg> element (not child elements like <rect>)
    .replace(/(<svg\b[^>]*?)\s+width="[^"]*"/i, '$1')
    .replace(/(<svg\b[^>]*?)\s+height="[^"]*"/i, '$1')
    // Some upstream logos contain empty, self-closing script elements.
    // Remove both forms of active elements, and quoted or unquoted handlers.
    .replace(/<(script|foreignObject)\b[^>]*\/>/gi, '')
    .replace(/<(script|foreignObject)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .trim()

  // Three decimal places are comfortably below a device pixel for these small
  // UI icons while removing verbose editor-export coordinates.
  return optimizeServiceIcon(sanitized)
}

// The logos API answers 200 with a generic grey placeholder for names it holds no
// logo for, so a successful fetch is not proof of a real mark. Detect it by the
// two colors its grid background is drawn with — no real icon in the set uses them.
const PLACEHOLDER_GRID_STROKE = '#e4e4e7'
const PLACEHOLDER_BACKGROUND_FILL = '#fafafa'

function isPlaceholderSvg(svg: string): boolean {
  const lower = svg.toLowerCase()
  return lower.includes(PLACEHOLDER_GRID_STROKE) && lower.includes(PLACEHOLDER_BACKGROUND_FILL)
}

async function fetchSvg(apiName: string): Promise<string | null> {
  try {
    const source = OFFICIAL_ICON_SOURCES[apiName]
    const res = await fetch(source?.url ?? `${COMPOSIO_LOGOS_API}/${apiName}`)
    if (!res.ok) return null
    let svg: string | undefined
    if (source?.archiveEntry) {
      const files = unzipSync(new Uint8Array(await res.arrayBuffer()), {
        filter: (file) => file.name === source.archiveEntry,
      })
      const file = files[source.archiveEntry]
      if (!file) return null
      svg = new TextDecoder().decode(file)
    } else if (source?.svgClass) {
      const html = await res.text()
      svg = html.match(/<svg\b[\s\S]*?<\/svg>/gi)?.find((element) =>
        element.match(/\bclass="([^"]*)"/)?.[1].split(/\s+/).includes(source.svgClass!)
      )
    } else {
      const contentType = res.headers.get('content-type') || ''
      if (!contentType.includes('svg')) return null
      svg = await res.text()
    }
    if (!svg) return null
    if (!svg.includes('<svg')) return null
    if (isPlaceholderSvg(svg)) return null
    return normalizeSvg(svg)
  } catch {
    return null
  }
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true })

  const args = process.argv.slice(2)
  const onlyMissing = args.includes('--only-missing')
  const requestedSlugs = args.filter((arg) => arg !== '--only-missing')
  for (const slug of requestedSlugs) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
      throw new Error(`Invalid service slug or option: ${slug}`)
    }
  }
  const catalogSlugs = [
    ...SUPPORTED_PROVIDERS.map((provider) => provider.slug),
    ...OTHER_SLUGS,
    ...Object.keys(SHARED_ICON_SLUGS),
  ]
  const allSlugs = [...new Set(requestedSlugs.length > 0 ? requestedSlugs : catalogSlugs)]
    .filter((slug) => !onlyMissing || !existsSync(path.join(OUTPUT_DIR, `${slug}.svg`)))

  // Deduplicate API names to avoid redundant fetches
  const apiNameToSlugs = new Map<string, string[]>()
  for (const slug of allSlugs) {
    const apiName = OFFICIAL_ICON_SOURCES[slug]
      ? slug
      : SHARED_ICON_SLUGS[slug] || SLUG_TO_API_NAME[slug] || slug
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
        if (!svg && !OFFICIAL_ICON_SOURCES[apiName] && slugs.length === 1 && slugs[0] !== apiName) {
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
    console.warn('\nExisting files were kept; missing icons will show a generic fallback.')
  }
}

main()

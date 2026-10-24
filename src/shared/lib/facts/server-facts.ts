import {
  SERVER_FACTS_ELEMENT_ID,
  osOf,
  type DesktopDistribution,
  type Os,
  type ServerFacts,
} from './facts-schema'

/**
 * The facts of this process, read where they are decided. This is the only
 * file that reads `process.mas` or `process.windowsStore` (lint rule
 * `no-restricted-properties`).
 *
 * Read on every call rather than cached: they can't change within a process,
 * and reading them live keeps a test that stubs `process.platform` honest.
 */

/** This computer's OS. */
export function currentOs(): Os {
  return osOf(process.platform)
}

/**
 * How this desktop install was distributed, or null outside Electron main.
 * Only main hosts the API, so a renderer gets this from main.
 */
export function desktopDistribution(): DesktopDistribution | null {
  if (process.type !== 'browser') return null
  if (process.mas) return 'mac-app-store'
  if (process.windowsStore) return 'windows-store'
  return 'direct'
}

/** The facts of the server this process is: a desktop install's API, or a web deployment. */
export function getServerFacts(): ServerFacts {
  return { os: currentOs(), distribution: desktopDistribution() ?? 'deployment' }
}

/**
 * The web build's HTML with this server's facts inlined, so a page knows them
 * before its first render without another request.
 *
 * A JSON data block, not a script: the browser never executes it. `<` is
 * escaped so no value can close the element early.
 */
export function withServerFacts(html: string, facts: ServerFacts): string {
  const json = JSON.stringify(facts).replace(/</g, '\\u003c')
  const block = `<script type="application/json" id="${SERVER_FACTS_ELEMENT_ID}">${json}</script>`
  if (!html.includes('</head>')) {
    throw new Error('Cannot inline server facts: the HTML has no </head>')
  }
  return html.replace('</head>', `${block}\n</head>`)
}

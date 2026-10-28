// For scripts/testflight-distribute.ts: after a full release, leave an App
// Store version ready to submit with that release's build. Submitting it for
// review stays a person's step.
import type { Client, Resource } from './testflight'

// The states in which App Store Connect lets a version's number and build change.
const EDITABLE = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'])
// The states of a version that is out, after which the next one is a new version.
const RELEASED = new Set([
  'READY_FOR_DISTRIBUTION', 'READY_FOR_SALE', 'REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE', 'DEVELOPER_REMOVED_FROM_SALE',
])
// What a new version takes from the last one's listing, per locale. App Store
// Connect copies the listing when a version is made on its website; this fills
// in whatever the API left empty.
const COPIED = ['description', 'keywords', 'promotionalText', 'marketingUrl', 'supportUrl'] as const

export interface PrepareOptions {
  appId: string
  platform: 'MAC_OS' | 'IOS'
  /** The release's version, e.g. 0.6.0. */
  versionString: string
  buildId: string
  /** What's New for an update, written where it is empty. The first version has none. */
  whatsNew?: string
  log?: (line: string) => void
}

export type PrepareResult = 'updated' | 'created' | 'released already' | 'version in review'

const state = (version: Resource) => String(version.attributes?.appVersionState ?? version.attributes?.appStoreState)
const versionString = (version: Resource) => String(version.attributes?.versionString)

/**
 * Leaves the platform's App Store version for `versionString` ready to submit
 * with the build: the version being prepared takes the release's number, or a
 * new version is made once the last one is out. While a version is in review,
 * App Store Connect takes no other, so the build is left for a person to attach.
 */
export async function prepareAppStoreVersion(client: Client, options: PrepareOptions): Promise<PrepareResult> {
  const { log = console.log } = options
  const query = new URLSearchParams({
    'filter[platform]': options.platform,
    'fields[appStoreVersions]': 'versionString,appVersionState,appStoreState,createdDate',
    limit: '200',
  })
  const { data } = await client.get(`/v1/apps/${options.appId}/appStoreVersions?${query}`)
  const versions = (Array.isArray(data) ? data : [])
    .sort((a, b) => String(b.attributes?.createdDate).localeCompare(String(a.attributes?.createdDate)))

  const released = versions.filter((v) => RELEASED.has(state(v)))
  if (released.some((v) => versionString(v) === options.versionString)) {
    log(`App Store version ${options.versionString} is out already; nothing to prepare`)
    return 'released already'
  }

  let target = versions.find((v) => EDITABLE.has(state(v)))
  let result: PrepareResult = 'updated'
  let listingFrom: Resource | undefined
  if (target) {
    if (versionString(target) !== options.versionString) {
      await client.send('PATCH', `/v1/appStoreVersions/${target.id}`, {
        data: { type: 'appStoreVersions', id: target.id, attributes: { versionString: options.versionString } },
      })
      log(`App Store version ${versionString(target)} (${state(target)}) is now ${options.versionString}`)
    }
  } else {
    const inReview = versions.find((v) => !RELEASED.has(state(v)))
    if (inReview) {
      log(`::notice title=App Store version not prepared::Version ${versionString(inReview)} is ${state(inReview)}, and App Store Connect takes no other version until it is out. Attach the build to ${options.versionString} by hand then.`)
      return 'version in review'
    }
    const created = (await client.send('POST', '/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: { platform: options.platform, versionString: options.versionString, releaseType: 'MANUAL' },
        relationships: { app: { data: { type: 'apps', id: options.appId } } },
      },
    })).data as Resource
    target = created
    result = 'created'
    listingFrom = released[0]
    log(`Created App Store version ${options.versionString} (release by hand after approval)`)
  }

  await client.send('PATCH', `/v1/appStoreVersions/${target.id}/relationships/build`, { data: { type: 'builds', id: options.buildId } })
  log(`Attached the build to App Store version ${options.versionString}`)

  await fillListing(client, target.id, listingFrom, released.length > 0 ? options.whatsNew : undefined, log)
  return result
}

async function localizations(client: Client, versionId: string): Promise<Resource[]> {
  const { data } = await client.get(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`)
  return Array.isArray(data) ? data : []
}

const empty = (value: unknown) => value === undefined || value === null || value === ''

/** Copies the last version's listing into the new one where it is missing, and writes What's New where it is empty. */
async function fillListing(
  client: Client, versionId: string, from: Resource | undefined, whatsNew: string | undefined, log: (line: string) => void,
): Promise<void> {
  const source = from ? await localizations(client, from.id) : []
  const target = await localizations(client, versionId)
  for (const src of source) {
    const locale = src.attributes?.locale
    if (target.some((t) => t.attributes?.locale === locale)) continue
    const attributes: Record<string, unknown> = { locale }
    for (const field of COPIED) if (!empty(src.attributes?.[field])) attributes[field] = src.attributes?.[field]
    if (whatsNew) attributes.whatsNew = whatsNew
    await client.send('POST', '/v1/appStoreVersionLocalizations', {
      data: { type: 'appStoreVersionLocalizations', attributes, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } } },
    })
    log(`Listing ${String(locale)}: copied from ${versionString(from!)}`)
  }
  for (const loc of target) {
    const src = source.find((s) => s.attributes?.locale === loc.attributes?.locale)
    const attributes: Record<string, unknown> = {}
    for (const field of COPIED) if (empty(loc.attributes?.[field]) && src && !empty(src.attributes?.[field])) attributes[field] = src.attributes?.[field]
    if (whatsNew && empty(loc.attributes?.whatsNew)) attributes.whatsNew = whatsNew
    if (Object.keys(attributes).length === 0) continue
    await client.send('PATCH', `/v1/appStoreVersionLocalizations/${loc.id}`, {
      data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes },
    })
    log(`Listing ${String(loc.attributes?.locale)}: filled ${Object.keys(attributes).join(', ')}`)
  }
}

import { z } from 'zod'
import { teamsIdentitySchema } from './config-schema'

const teamsPackageInput = z.object({
  appId: teamsIdentitySchema.shape.appId,
  name: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Use a version such as 1.0.0'),
})

/** Both IDs come from the same manual bot registration so downloading the ZIP again updates the same app. */
export function teamsManifest(input: z.input<typeof teamsPackageInput>) {
  const { appId, name, description, version } = teamsPackageInput.parse(input)
  const summary = description?.trim() || `Work with ${name} in Microsoft Teams.`
  const shorten = (value: string, max: number) => Array.from(value).slice(0, max).join('')
  return {
    $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.25/MicrosoftTeams.schema.json',
    manifestVersion: '1.25',
    supportsChannelFeatures: 'tier1',
    version,
    id: appId,
    developer: {
      name: 'Gamut',
      websiteUrl: 'https://www.gamut.so',
      privacyUrl: 'https://www.gamut.so/pages/privacy-policy',
      termsOfUseUrl: 'https://www.gamut.so/pages/terms-of-service',
    },
    name: { short: shorten(name, 30), full: shorten(name, 100) },
    description: { short: shorten(summary, 80), full: shorten(summary, 4000) },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: '#5455A8',
    bots: [{ botId: appId, scopes: ['personal', 'team', 'groupChat'], supportsFiles: true }],
  }
}

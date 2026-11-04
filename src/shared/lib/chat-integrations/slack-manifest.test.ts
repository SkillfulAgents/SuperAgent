import { describe, expect, it } from 'vitest'
import { slackAppManifest } from './slack-manifest'

describe('slackAppManifest', () => {
  it('gives the app and its bot user the same name, so neither is left to rename in Slack', () => {
    const manifest = slackAppManifest({ name: 'Infra Agent' })
    expect(manifest.display_information).toEqual({ name: 'Infra Agent' })
    expect(manifest.features.bot_user.display_name).toBe('Infra Agent')
  })

  it('carries a description and background colour when there are any', () => {
    expect(slackAppManifest({ name: 'A', description: 'Keeps\n the servers  up', backgroundColor: '#1B6F75' }).display_information)
      .toEqual({ name: 'A', description: 'Keeps the servers up', background_color: '#1B6F75' })
  })

  it('keeps within Slack’s limits: 35 characters of app name, 140 of description on a word boundary', () => {
    const manifest = slackAppManifest({ name: 'An agent with a very long name indeed, really', description: `${'word '.repeat(40)}end` })
    expect(manifest.display_information.name).toHaveLength(35)
    expect(manifest.features.bot_user.display_name).toBe('An agent with a very long name indeed, really')
    expect(manifest.display_information.description!.length).toBeLessThanOrEqual(140)
    expect(manifest.display_information.description).toMatch(/word…$/)
  })
})

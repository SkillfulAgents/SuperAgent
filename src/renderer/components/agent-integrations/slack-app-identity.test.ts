// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { OFFERED_ORBS } from '@renderer/components/agents/agent-avatar/avatar-orbs'
import { ORB_SHAPES } from '@renderer/components/agents/agent-avatar/orb-shapes'
import { orbSvg } from '@renderer/components/agents/agent-avatar/orb-image'
import { slackAppIdentity, slackBackgroundColor } from './slack-app-identity'

const contrastWithWhite = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05)
}

describe('slackBackgroundColor', () => {
  it('keeps a rim white text already reads on, and darkens one it does not', () => {
    const orb = (name: string) => OFFERED_ORBS.find(o => o.name === name)!
    expect(slackBackgroundColor(orb('tonal-red'))).toBe(orb('tonal-red').rim)
    expect(slackBackgroundColor(orb('tonal-amber'))).not.toBe(orb('tonal-amber').rim)
  })

  it.each(OFFERED_ORBS.map(orb => [orb.name, orb] as const))('gives %s a colour Slack’s white name reads on', (_, orb) => {
    const colour = slackBackgroundColor(orb)
    expect(colour).toMatch(/^#[0-9A-F]{6}$/)
    expect(contrastWithWhite(colour)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('slackAppIdentity', () => {
  const agent = { slug: 'a', name: 'Infra Agent', description: '  Keeps the servers up ', avatar: { color: 'tonal-teal' as const, shape: 'hexagon' as const } }

  it('takes a name given over the agent’s, and Gamut Bot without either', () => {
    expect(slackAppIdentity(agent).name).toBe('Infra Agent')
    expect(slackAppIdentity(agent, ' Helper ').name).toBe('Helper')
    expect(slackAppIdentity(undefined).name).toBe('Gamut Bot')
  })

  it('carries the agent’s description and its avatar’s colour', () => {
    expect(slackAppIdentity(agent)).toMatchObject({ description: 'Keeps the servers up', backgroundColor: expect.stringMatching(/^#[0-9A-F]{6}$/) })
    expect(slackAppIdentity({ ...agent, avatar: null, description: '' })).toEqual({ name: 'Infra Agent', description: undefined, backgroundColor: undefined })
  })
})

describe('orbSvg', () => {
  it.each(ORB_SHAPES.map(shape => [shape.name, shape] as const))('draws a %s orb as well-formed SVG', (_, shape) => {
    const svg = orbSvg({ orb: OFFERED_ORBS[0], shape, restingPhi: -90, size: 1024, fill: 0.7, background: '#FFFFFF' })
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.documentElement.getAttribute('width')).toBe('1024')
    // Form-following shading and the face's highlight are blurred copies of the outline; the circle has neither.
    expect(doc.querySelectorAll('g[filter]')).toHaveLength(shape.name === 'circle' ? 0 : 2)
  })
})

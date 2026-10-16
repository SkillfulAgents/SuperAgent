import { describe, expect, it } from 'vitest'

import { applyGrammar, gazeToward, nearestAngle, ORB_SHAPES, orbShape, reach, shapePath } from './orb-shapes'

const direction = (phi: number) => ((phi % 360) + 360) % 360

describe('orb shapes', () => {
  it('has the eight shapes, each outline inside its box', () => {
    expect(ORB_SHAPES.map(shape => shape.name)).toEqual(['circle', 'squircle', 'triangle', 'diamond', 'hexagon', 'pill', 'arch', 'bloom'])
    for (const shape of ORB_SHAPES) {
      const coords = shapePath(shape, 30).match(/-?\d+\.\d+/g)!.map(Number)
      for (const value of coords) {
        expect(value).toBeGreaterThanOrEqual(-0.5)
        expect(value).toBeLessThanOrEqual(30.5)
      }
    }
  })

  it('measures how far the outline reaches in a direction', () => {
    expect(reach(orbShape('circle').points, 1, 0)).toBeCloseTo(0.96, 2)
    expect(reach(orbShape('pill').points, 1, 0)).toBeCloseTo(0.96, 2)
    expect(reach(orbShape('pill').points, 0, 1)).toBeCloseTo(0.6, 2)
  })

  it('turns the short way round', () => {
    expect(nearestAngle(350, 10)).toBe(370)
    expect(nearestAngle(10, 350)).toBe(-10)
  })

  it('lets free shapes look anywhere', () => {
    expect(applyGrammar(orbShape('circle'), 0, 37, 0.6)).toEqual({ phi: 37, distance: 0.6 })
  })

  it('snaps the squircle to the compass and pushes its face to the edge', () => {
    const gaze = applyGrammar(orbShape('squircle'), 0, 37, 0.6)
    expect(direction(gaze.phi)).toBe(45)
    expect(gaze.distance).toBe(1)
  })

  it('turns a snapping shape to the viewer, keeping its direction, when the gaze is close in', () => {
    expect(applyGrammar(orbShape('triangle'), 30, 100, 0.2)).toEqual({ phi: 30, distance: 0 })
  })

  it('slides the pill along its length without snapping the distance', () => {
    const gaze = applyGrammar(orbShape('pill'), 0, 160, 0.4)
    expect(direction(gaze.phi)).toBe(180)
    expect(gaze.distance).toBe(0.4)
  })

  it('looks toward a point, coming in as it nears', () => {
    const circle = orbShape('circle')
    const right = gazeToward(circle, { phi: 0, distance: 1 }, 500, 0, 30)
    expect(direction(right.phi)).toBeCloseTo(0)
    expect(right.distance).toBe(1)
    expect(gazeToward(circle, right, 2, 0, 30).distance).toBeLessThan(0.1)
  })
})

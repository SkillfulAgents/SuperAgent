import { describe, expect, it, vi } from 'vitest'

import { createNotificationEventSourceController } from './notification-listener'

describe('createNotificationEventSourceController', () => {
  it('replaces a local stream with one under the effective cloud API base URL', () => {
    let baseUrl = 'http://localhost:47891'
    const local = { close: vi.fn() }
    const cloud = { close: vi.fn() }
    const createEventSource = vi.fn()
      .mockReturnValueOnce(local)
      .mockReturnValueOnce(cloud)
    const controller = createNotificationEventSourceController(
      () => baseUrl,
      createEventSource,
    )

    expect(controller.restart()).toBe(local)
    baseUrl = 'http://localhost:47891/cloud/KEY123'
    expect(controller.restart()).toBe(cloud)

    expect(local.close).toHaveBeenCalledOnce()
    expect(createEventSource).toHaveBeenNthCalledWith(
      1,
      'http://localhost:47891/api/notifications/stream',
    )
    expect(createEventSource).toHaveBeenNthCalledWith(
      2,
      'http://localhost:47891/cloud/KEY123/api/notifications/stream',
    )
  })

  it('closes the active stream when stopped', () => {
    const source = { close: vi.fn() }
    const controller = createNotificationEventSourceController(
      () => 'http://localhost:47891',
      () => source,
    )

    controller.restart()
    controller.stop()
    controller.stop()

    expect(source.close).toHaveBeenCalledOnce()
  })
})

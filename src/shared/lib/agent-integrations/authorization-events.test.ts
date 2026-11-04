import { afterEach, expect, it, vi } from 'vitest'
const reported = vi.hoisted(() => vi.fn())
vi.mock('../error-reporting', () => ({ captureException: reported }))
import { appState } from '../app-state'
import type { Subscription } from '../app-state'
import { backgroundSettled } from '../background'
import { IntegrationAuthorizationWatch, integrationAuthorization, publishIntegrationAuthorization, type IntegrationAuthorizationEvent } from './authorization-events'

afterEach(() => { vi.restoreAllMocks(); reported.mockClear() })

const lost = (integrationId: string): IntegrationAuthorizationEvent => ({ type: 'authorization_lost', integrationId })
function recorder() {
  const heard: string[] = []
  return { heard, watch: new IntegrationAuthorizationWatch(async event => { heard.push(event.integrationId) }) }
}

it('hears the integrations it watches, once each however often it is asked to watch them', async () => {
  const { heard, watch } = recorder()
  watch.watch('a'); watch.watch('a'); watch.watch('b')
  await backgroundSettled()
  await publishIntegrationAuthorization(lost('a'))
  await publishIntegrationAuthorization(lost('other'))
  await publishIntegrationAuthorization(lost('b'))
  await backgroundSettled()
  expect(heard).toEqual(['a', 'b'])
  watch.close()
})

it('stops hearing an integration once released, and every one once closed', async () => {
  const { heard, watch } = recorder()
  watch.watch('a'); watch.watch('b')
  await backgroundSettled()
  watch.release('a')
  await publishIntegrationAuthorization(lost('a'))
  await publishIntegrationAuthorization(lost('b'))
  await backgroundSettled()
  expect(heard).toEqual(['b'])
  watch.close()
  await publishIntegrationAuthorization(lost('b'))
  await backgroundSettled()
  expect(heard).toEqual(['b'])
  // Watching again after a release subscribes afresh.
  watch.watch('a')
  await backgroundSettled()
  await publishIntegrationAuthorization(lost('a'))
  await backgroundSettled()
  expect(heard).toEqual(['b', 'a'])
  watch.close()
})

it('ends a subscription closed while it is still being set up', async () => {
  const state = appState()
  const subscribe = state.subscribe.bind(state)
  let setUp!: () => void
  const gate = new Promise<void>(resolve => { setUp = resolve })
  const subscriptions: Promise<Subscription>[] = []
  vi.spyOn(state, 'subscribe').mockImplementation((channels, listener, options) => {
    const subscription = gate.then(() => subscribe(channels, listener, options))
    subscriptions.push(subscription)
    return subscription
  })
  const { heard, watch } = recorder()
  watch.watch('a')
  watch.close()
  setUp()
  await Promise.all(subscriptions)
  await publishIntegrationAuthorization(lost('a'))
  await backgroundSettled()
  expect(heard).toEqual([])
})

it('reports a failed subscription and builds it again on the next watch', async () => {
  const state = appState()
  vi.spyOn(state, 'subscribe').mockRejectedValueOnce(new Error('backend unavailable'))
  const { heard, watch } = recorder()
  watch.watch('a')
  await backgroundSettled()
  expect(reported).toHaveBeenCalledOnce()
  watch.watch('a')
  await backgroundSettled()
  await publishIntegrationAuthorization(lost('a'))
  await backgroundSettled()
  expect(heard).toEqual(['a'])
  watch.close()
})

it('sends ids only: extra fields are not part of the event', async () => {
  const heard: unknown[] = []
  await appState().subscribe([integrationAuthorization.channel('a')], event => { heard.push(event) })
  await publishIntegrationAuthorization({ ...lost('a'), botToken: 'secret' } as IntegrationAuthorizationEvent)
  await backgroundSettled()
  expect(heard).toEqual([lost('a')])
})

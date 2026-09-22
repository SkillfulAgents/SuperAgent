import type { DeliveryAttempt } from '../delivery-queue'
/** Manager unit-test seam; the durable checkpoint is covered with a real DB separately. */
export const testDeliveryAttempt: DeliveryAttempt = {
  id: 'delivery-uuid', sessionId: null, assertCurrent() {}, bind: async () => {},
  handoff: (_session, send) => send(), consume: (_session, consume) => consume(),
}

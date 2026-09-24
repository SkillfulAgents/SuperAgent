import type { DeliveryAttempt } from '../delivery-queue'
/** Manager unit-test seam; the durable checkpoint is covered with a real DB separately. */
export const testDeliveryAttempt: DeliveryAttempt = {
  id: 'delivery-uuid', assertCurrent() {}, assertOwned: async () => {}, bind: async () => {}, notifyRoute: send => send(),
  handoff: (_session, send, check) => { check?.(); return send() }, consume: (_session, consume, check) => { check?.(); return consume() },
}

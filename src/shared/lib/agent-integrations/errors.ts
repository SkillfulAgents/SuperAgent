/**
 * A refusal a family explains to the person who asked: the request was
 * understood, and the answer is no (not in a meeting, unknown target, the
 * integration is paused). Routes answer these with 400 and the message; any
 * other error is a fault and is reported.
 */
export class IntegrationPolicyError extends Error {
  constructor(message: string) { super(message); this.name = 'IntegrationPolicyError' }
}

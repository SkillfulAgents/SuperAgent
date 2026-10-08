// Deliberately limited to funnel steps and counters: credentials, device codes,
// account labels, connection names, and raw errors must never reach analytics.
export type ConnectionSetupEvent =
  | { step: 'sign_in_started' | 'sign_in_opened' | 'sign_in_succeeded'; signInAttempt: number }
  | { step: 'sign_in_failed'; signInAttempt: number; failureStage: 'start' | 'poll'; httpStatus?: number }
  | { step: 'token_entered' }
  | { step: 'save_started' | 'saved' | 'save_failed'; saveAttempt: number }

export type ConnectionSetupObserver = (event: ConnectionSetupEvent) => void

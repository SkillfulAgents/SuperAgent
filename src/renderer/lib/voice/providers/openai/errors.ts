/** Map OpenAI Realtime error objects to user-friendly messages. */
export function friendlyRealtimeError(err: { code?: string; message?: string } | undefined): string {
  const code = err?.code || ''
  const msg = err?.message || 'OpenAI Realtime error'
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached' ||
      code === 'rate_limit_exceeded' || /quota|billing|insufficient/i.test(msg)) {
    return 'OpenAI API quota exceeded. Please check your OpenAI account balance and billing settings.'
  }
  return msg
}

/** Only failures before the initial input is submitted carry rejection evidence. */
export class SessionInputNotAcceptedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** Preserve launch diagnostics while exposing the acceptance boundary to the host. */
export function sessionCreationFailure(error: unknown) {
  const rejected = error instanceof SessionInputNotAcceptedError;
  const cause = rejected ? error.cause : error;
  const detail = cause && typeof cause === 'object' ? cause as Record<string, unknown> : {};
  return {
    error: cause instanceof Error ? cause.message : 'Failed to create session',
    ...(typeof detail.code === 'string' && { code: detail.code }),
    ...(typeof detail.errorClass === 'string' && { errorClass: detail.errorClass }),
    ...(rejected && { inputAccepted: false }),
  };
}

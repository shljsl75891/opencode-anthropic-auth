/**
 * Error thrown when an HTTP 200 Anthropic stream can't be forwarded safely —
 * either Anthropic emitted a retryable server-side error inside the stream, or
 * we can't parse what arrived. OpenCode recognises ECONNRESET + anthropic-sse
 * syscall and applies its normal auto-retry flow instead of surfacing an
 * unknown error.
 */
export type RetryableAnthropicStreamError = Error & {
  code: 'ECONNRESET'
  syscall: 'anthropic-sse'
  providerErrorType?: string
}

export function retryableAnthropicStreamError(
  errorType: string | undefined,
  message: string,
): RetryableAnthropicStreamError {
  const detail = errorType ? `${errorType}: ${message}` : message
  const err = new Error(
    `Anthropic stream error: ${detail}`,
  ) as RetryableAnthropicStreamError
  err.code = 'ECONNRESET'
  err.syscall = 'anthropic-sse'
  if (errorType) err.providerErrorType = errorType
  return err
}

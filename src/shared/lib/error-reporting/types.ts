export type SeverityLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug'

export interface ErrorReportingInitOptions {
  environment: string
}

export interface ErrorContext {
  tags?: Record<string, string>
  extra?: Record<string, unknown>
  fingerprint?: string[]
  level?: SeverityLevel
}

export interface ErrorReportingUser {
  id?: string
  email?: string
}

export interface Breadcrumb {
  category: string
  message: string
  level?: SeverityLevel
  data?: Record<string, unknown>
}

export interface ErrorReportingProvider {
  captureException(error: unknown, context?: ErrorContext): string | undefined
  captureMessage(message: string, context?: ErrorContext): string | undefined
  setUser(user: ErrorReportingUser | null): void
  addBreadcrumb(breadcrumb: Breadcrumb): void
  setContext(name: string, context: Record<string, unknown>): void
  setTag(key: string, value: string): void
  flush(timeoutMs?: number): Promise<boolean>
}

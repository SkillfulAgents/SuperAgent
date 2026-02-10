import { Component, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from './button'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Custom fallback UI. If not provided, a default fallback is shown. */
  fallback?: ReactNode
  /** Use compact layout (for sidebar or narrow areas) */
  compact?: boolean
  /** Callback when an error is caught */
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
    this.props.onError?.(error, errorInfo)
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  private handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      if (this.props.compact) {
        return (
          <div className="flex flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
            <AlertTriangle className="h-4 w-4" />
            <p className="text-xs text-center">Something went wrong</p>
            <Button variant="ghost" size="sm" onClick={this.handleRetry} className="text-xs h-7">
              Retry
            </Button>
          </div>
        )
      }

      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-muted-foreground">
          <AlertTriangle className="h-8 w-8" />
          <div className="text-center space-y-1">
            <p className="text-sm font-medium">Something went wrong</p>
            <p className="text-xs">{this.state.error?.message}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={this.handleRetry}>
              Retry
            </Button>
            <Button variant="outline" size="sm" onClick={this.handleReload}>
              Reload Page
            </Button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { openAssistantWithContext } from '@/features/assistant/assistant-store'
import { i18n } from '@/i18n'

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info)
  }

  handleReset = () => {
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    const { children, fallback } = this.props

    if (error) {
      if (fallback) return fallback(error, this.handleReset)
      return (
        <div className="grid min-h-screen place-items-center bg-background p-6">
          <div className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-6 shadow-sm">
            <div>
              <h2 className="text-lg font-semibold text-destructive">
                {i18n.t('errorBoundary.title')}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {i18n.t('errorBoundary.description')}
              </p>
            </div>
            <pre className="max-h-48 overflow-auto rounded bg-muted p-3 text-xs text-muted-foreground">
              {error.stack ?? error.message}
            </pre>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  openAssistantWithContext(
                    [
                      'GeoD interface render error',
                      `message: ${error.message}`,
                      `stack: ${error.stack ?? i18n.t('errorBoundary.unavailable')}`,
                    ].join('\n'),
                    i18n.t('errorBoundary.assistantPrompt'),
                  )
                }
              >
                <Sparkles className="size-4" />
                {i18n.t('errorBoundary.askAssistant')}
              </Button>
              <Button variant="outline" onClick={() => window.location.reload()}>
                {i18n.t('errorBoundary.reload')}
              </Button>
              <Button onClick={this.handleReset}>{i18n.t('errorBoundary.reset')}</Button>
            </div>
          </div>
        </div>
      )
    }

    return children
  }
}

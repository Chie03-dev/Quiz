import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Button } from './Button'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Shows a render error instead of a white screen.
 *
 * A mistake in a screen used to leave the instructor with an empty window
 * and no way out - and a teacher in front of a class cannot tell an empty
 * window from a crashed one. Now the screen says what went wrong and offers
 * a way back, and the shell around it keeps working, so the other screens
 * are still reachable.
 *
 * The error is also logged, which is what the UI check reads to fail loudly
 * instead of timing out on a blank screen.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('the screen failed to render:', error.message, info.componentStack ?? '')
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="ui-boundary" data-testid="render-error">
        <EmptyState
          title="This screen ran into a problem"
          body={error.message}
          icon={<Icon name="zap" />}
          action={
            <Button variant="secondary" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }
}

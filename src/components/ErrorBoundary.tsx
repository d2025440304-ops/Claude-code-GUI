import { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * 全局错误边界：捕获子组件渲染期间抛出的错误，避免整个应用白屏。
 * 提供重试按钮重置内部状态。
 */
export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] 捕获到渲染错误:', error, info)
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--fg-secondary)', height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <h2 style={{ marginBottom: 12, color: 'var(--fg-primary)' }}>Something went wrong</h2>
        <p style={{ marginBottom: 8, color: 'var(--fg-tertiary)', fontSize: 13, maxWidth: 480, wordBreak: 'break-word' }}>
          {this.state.error?.message || 'An unexpected error occurred'}
        </p>
        <p style={{ marginBottom: 20, color: 'var(--fg-quaternary)', fontSize: 11 }}>
          Check the console for details
        </p>
        <button onClick={this.handleReset} className="btn btn-primary">
          Try Again
        </button>
      </div>
    )
  }
}

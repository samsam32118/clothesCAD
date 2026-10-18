import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Shown in the message, e.g. "Pattern". */
  area: string;
  children: ReactNode;
  /** Changing this value clears a caught error (e.g. a new design id). */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
  resetKey: unknown;
}

/** Keeps one broken panel from taking down the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { resetKey: props.resetKey, error: null };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`clothesCAD: ${this.props.area} crashed`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-panel" role="alert">
        <h2>Something went wrong in {this.props.area}</h2>
        <p>Your measurements and choices are safe. Try again, or change a setting and redesign.</p>
        <pre>{error.message}</pre>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}

import { Component, lazy, Suspense, type ReactNode } from 'react';

const HighlightedCode = lazy(() => import('./HighlightedCode'));

export interface CodeHighlighterProps {
  code: string;
  language?: string;
  theme?: 'light' | 'dark';
  className?: string;
}

class HighlightErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default function CodeHighlighter(props: CodeHighlighterProps) {
  const fallback = <pre className={props.className} style={{ margin: 0, overflow: 'auto' }}>
    <code>{props.code}</code>
  </pre>;

  return <HighlightErrorBoundary fallback={fallback}>
    <Suspense fallback={fallback}>
      <HighlightedCode {...props} />
    </Suspense>
  </HighlightErrorBoundary>;
}

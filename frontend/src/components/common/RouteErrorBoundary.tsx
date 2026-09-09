import { Component, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from '../../i18n';

interface BoundaryProps {
  children: ReactNode;
  title: string;
  description: string;
  reloadLabel: string;
  homeLabel: string;
  resetKey: string;
}

interface BoundaryState {
  failed: boolean;
  resetKey: string;
}

class Boundary extends Component<BoundaryProps, BoundaryState> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState) {
    if (props.resetKey !== state.resetKey) return { failed: false, resetKey: props.resetKey };
    return null;
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <main role="alert" style={{ padding: 48, textAlign: 'center' }}>
      <h1>{this.props.title}</h1>
      <p>{this.props.description}</p>
      <button onClick={() => window.location.reload()}>{this.props.reloadLabel}</button>
      {' '}
      <a href="/workspace">{this.props.homeLabel}</a>
    </main>;
  }
}

export default function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { t } = useTranslation();
  return <Boundary
    resetKey={location.pathname + location.search}
    title={t('errors.pageLoadTitle')}
    description={t('errors.pageLoadDescription')}
    reloadLabel={t('common.reload')}
    homeLabel={t('common.backToWorkspace')}
  >{children}</Boundary>;
}

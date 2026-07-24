import { Component, type ErrorInfo, type ReactNode } from 'react';

import { recordDiagnosticEvent } from '../services/diagnostics-api';

interface AppErrorBoundaryProps {
  readonly children: ReactNode;
}

interface AppErrorBoundaryState {
  readonly failed: boolean;
}

function callSiteFrames(stack: string | undefined): string | null {
  if (!stack) return null;
  return stack
    .split(/\r?\n/u)
    .filter((line) => /^\s*at\s/u.test(line))
    .slice(0, 4)
    .join('\n')
    .slice(0, 240) || null;
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void recordDiagnosticEvent({
      level: 'error',
      component: 'renderer',
      event: 'renderer.react_error_boundary',
      fields: {
        errorName: error.name || 'Error',
        errorStack: callSiteFrames(error.stack),
        componentStack: info.componentStack?.slice(0, 240) ?? null,
      },
    }).catch(() => undefined);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="fatal-error-page">
        <section role="alert">
          <p className="eyebrow">Phrio 已保留本机诊断信息</p>
          <h1>这个页面没有正常完成加载</h1>
          <p>练习记录不会因此被清除。重新载入后仍有问题时，可在“常规与隐私”中导出诊断包。</p>
          <button className="primary-button" onClick={() => window.location.reload()} type="button">
            重新载入 Phrio
          </button>
        </section>
      </main>
    );
  }
}

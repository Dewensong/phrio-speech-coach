import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app';
import { AppErrorBoundary } from './components/app-error-boundary';
import { recordDiagnosticEvent } from './services/diagnostics-api';
import './styles.css';

function safeRendererStack(value: unknown): string | null {
  if (!(value instanceof Error) || !value.stack) return null;
  // The first stack line contains the Error message, which can include user
  // content or a provider response. Keep only short call-site frames.
  return value.stack
    .split(/\r?\n/u)
    .filter((line) => /^\s*at\s/u.test(line))
    .slice(0, 4)
    .join('\n')
    .slice(0, 240) || null;
}

window.addEventListener('error', (event) => {
  void recordDiagnosticEvent({
    level: 'error',
    component: 'renderer',
    event: 'renderer.window_error',
    fields: {
      errorName: event.error instanceof Error ? event.error.name : 'ErrorEvent',
      errorStack: safeRendererStack(event.error),
    },
  }).catch(() => undefined);
});

window.addEventListener('unhandledrejection', (event) => {
  void recordDiagnosticEvent({
    level: 'error',
    component: 'renderer',
    event: 'renderer.unhandled_rejection',
    fields: {
      errorName: event.reason instanceof Error ? event.reason.name : typeof event.reason,
      errorStack: safeRendererStack(event.reason),
    },
  }).catch(() => undefined);
});

const root = document.getElementById('root');

if (!root) {
  const failure = document.createElement('main');
  failure.className = 'fatal-error-page';
  failure.setAttribute('role', 'alert');
  failure.textContent = 'Phrio 无法找到应用容器（PHRIO_ROOT_MISSING）。请重新启动应用。';
  document.body.replaceChildren(failure);
} else if (!import.meta.env.DEV && !window.phrio) {
  createRoot(root).render(
    <main className="fatal-error-page">
      <section role="alert">
        <p className="eyebrow">PHRIO_DESKTOP_BRIDGE_UNAVAILABLE</p>
        <h1>Phrio 没有完成桌面连接</h1>
        <p>请完全退出后重新打开应用；如果仍然出现，可将这个错误码和截图用于排查。</p>
        <button className="primary-button" onClick={() => window.location.reload()} type="button">
          重新载入 Phrio
        </button>
      </section>
    </main>,
  );
} else {
  createRoot(root).render(
    <StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </StrictMode>,
  );
}

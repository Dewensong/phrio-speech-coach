import type {
  ClearDiagnosticLogsOutput,
  DiagnosticStatus,
  ExportDiagnosticBundleOutput,
  OpenDiagnosticDirectoryOutput,
  RecordDiagnosticEventInput,
  RecordDiagnosticEventOutput,
} from '../../shared';

function desktopBridge() {
  if (typeof window !== 'undefined' && window.phrio) return window.phrio;
  throw new Error('PHRIO_DESKTOP_BRIDGE_UNAVAILABLE');
}

/**
 * Renderer events cross one narrow, schema-validated bridge. Development-only
 * browser previews may omit the desktop bridge, so instrumentation must never
 * make the preview itself fail; production treats the missing bridge as fatal.
 */
export function recordDiagnosticEvent(
  input: RecordDiagnosticEventInput,
): Promise<RecordDiagnosticEventOutput | null> {
  const record = typeof window === 'undefined'
    ? undefined
    : window.phrio?.recordDiagnosticEvent;
  if (typeof record !== 'function') {
    return Promise.resolve(null);
  }
  // Convert both a synchronous preload failure and an async IPC rejection into
  // a no-op. Instrumentation is never allowed to break the product action it
  // observes; the status API independently exposes writer failures.
  return Promise.resolve()
    .then(() => record.call(window.phrio, input))
    .catch(() => null);
}

export function getDiagnosticStatus(): Promise<DiagnosticStatus> {
  return desktopBridge().getDiagnosticStatus();
}

export function openDiagnosticDirectory(): Promise<OpenDiagnosticDirectoryOutput> {
  return desktopBridge().openDiagnosticDirectory();
}

export function exportDiagnosticBundle(): Promise<ExportDiagnosticBundleOutput> {
  return desktopBridge().exportDiagnosticBundle();
}

export function clearDiagnosticLogs(): Promise<ClearDiagnosticLogsOutput> {
  return desktopBridge().clearDiagnosticLogs();
}

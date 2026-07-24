import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsPage } from '../../src/frontend/pages/settings-page';
import { recordDiagnosticEvent } from '../../src/frontend/services/diagnostics-api';
import {
  APPROVED_AI_PROVIDER,
  DEFAULT_APP_SETTINGS,
  type DiagnosticStatus,
  type PhrioDesktopApi,
} from '../../src/shared';

const diagnosticStatus: DiagnosticStatus = {
  appVersion: '0.1.0-alpha.0',
  currentRunId: 'run-current-1',
  logDirectory: '/private/phrio-data/diagnostics',
  retentionDays: 7,
  maximumTotalBytes: 25 * 1_024 * 1_024,
  maximumBufferedEvents: 2_048,
  fileCount: 3,
  totalBytes: 1_536,
  bufferedEventCount: 0,
  droppedEventCount: 0,
  writeFailureCount: 0,
  latestIncidentId: 'incident-renderer-1',
};

function installBridge(overrides: Record<string, unknown> = {}) {
  const cloudConfiguration = {
    provider: 'openai' as const,
    providerName: 'OpenAI' as const,
    model: APPROVED_AI_PROVIDER.model,
    endpoint: APPROVED_AI_PROVIDER.endpoint,
    protocolVersion: APPROVED_AI_PROVIDER.protocolVersion,
    configured: false,
    encryptionAvailable: true,
    keyStorage: 'system_encrypted' as const,
    keyHint: null,
    retentionNotice: APPROVED_AI_PROVIDER.retentionNotice,
  };
  const bridge = {
    getEnvironmentStatus: vi.fn().mockResolvedValue({
      checkedAt: '2026-07-18T04:00:00.000Z',
      dataDirectory: '/private/phrio-data',
      trainingRecordCount: 0,
      localAsr: {
        ready: true,
        files: [
          { name: 'encoder.int8.onnx' as const, exists: true, readable: true },
          { name: 'decoder.int8.onnx' as const, exists: true, readable: true },
          { name: 'tokens.txt' as const, exists: true, readable: true },
        ],
      },
    }),
    getSettings: vi.fn().mockResolvedValue(DEFAULT_APP_SETTINGS),
    getCloudAiConfiguration: vi.fn().mockResolvedValue(cloudConfiguration),
    getCloudAiConsentStatus: vi.fn().mockResolvedValue({
      purpose: 'live_hint',
      active: false,
      consent: null,
    }),
    getDiagnosticStatus: vi.fn().mockResolvedValue(diagnosticStatus),
    openDiagnosticDirectory: vi.fn().mockResolvedValue({ opened: true, errorCode: null }),
    exportDiagnosticBundle: vi.fn().mockResolvedValue({
      cancelled: false,
      filePath: '/private/example-desktop/phrio-diagnostics.json',
      sourceFileCount: 3,
      eventCount: 42,
      byteLength: 4_096,
    }),
    clearDiagnosticLogs: vi.fn().mockResolvedValue({
      deletedFileCount: 3,
      deletedBytes: 1_536,
    }),
    ...overrides,
  } as unknown as PhrioDesktopApi;
  Object.defineProperty(window, 'phrio', { configurable: true, value: bridge });
  return bridge;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'phrio', { configurable: true, value: undefined });
});

describe('settings diagnostics controls', () => {
  it('keeps a development preview usable when the diagnostics bridge is absent', async () => {
    Object.defineProperty(window, 'phrio', { configurable: true, value: undefined });
    await expect(recordDiagnosticEvent({
      level: 'info',
      component: 'renderer',
      event: 'renderer.preview_ready',
    })).resolves.toBeNull();
  });

  it('turns a synchronous diagnostics bridge failure into a fail-open no-op', async () => {
    installBridge({
      recordDiagnosticEvent: vi.fn(() => {
        throw new Error('preload unavailable');
      }),
    });

    await expect(recordDiagnosticEvent({
      level: 'info',
      component: 'renderer',
      event: 'renderer.fail-open-check',
    })).resolves.toBeNull();
  });

  it('loads status, opens the directory, exports a bundle, and refreshes after clearing', async () => {
    const getDiagnosticStatus = vi.fn()
      .mockResolvedValueOnce(diagnosticStatus)
      .mockResolvedValue({
        ...diagnosticStatus,
        fileCount: 0,
        totalBytes: 0,
        bufferedEventCount: 0,
        latestIncidentId: null,
      });
    const bridge = installBridge({ getDiagnosticStatus });

    render(<SettingsPage />);

    expect(await screen.findByText('/private/phrio-data/diagnostics')).toBeInTheDocument();
    expect(screen.getByText('3 个 · 1.5 KB')).toBeInTheDocument();
    expect(screen.getAllByText('0 条')).toHaveLength(3);
    expect(screen.getByText('0 次')).toBeInTheDocument();
    expect(screen.getByText('incident-renderer-1')).toBeInTheDocument();
    expect(screen.getByText(/删除全部训练会话.*诊断日志/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '打开日志目录' }));
    expect(await screen.findByText('已在 Finder 中打开日志目录。')).toBeInTheDocument();
    expect(bridge.openDiagnosticDirectory).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: '导出诊断包' }));
    expect(await screen.findByText(/诊断包已导出到 .*phrio-diagnostics\.json（42 条事件）/)).toBeInTheDocument();
    expect(bridge.exportDiagnosticBundle).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: '清除诊断日志' }));
    expect(await screen.findByText('已清除 3 个诊断日志文件。')).toBeInTheDocument();
    await waitFor(() => expect(getDiagnosticStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByText('0 个 · 0 B')).toBeInTheDocument();
    expect(screen.getByText('暂无')).toBeInTheDocument();
  });

  it('reports an export cancellation without changing local logs', async () => {
    installBridge({
      exportDiagnosticBundle: vi.fn().mockResolvedValue({
        cancelled: true,
        filePath: null,
        sourceFileCount: 0,
        eventCount: 0,
        byteLength: 0,
      }),
    });
    render(<SettingsPage />);
    await screen.findByText('/private/phrio-data/diagnostics');

    fireEvent.click(screen.getByRole('button', { name: '导出诊断包' }));
    expect(await screen.findByText('已取消导出诊断包；本机日志没有改变。')).toBeInTheDocument();
    expect(screen.getByText('3 个 · 1.5 KB')).toBeInTheDocument();
  });

  it('refreshes live status and surfaces a constrained diagnostic writer', async () => {
    const getDiagnosticStatus = vi.fn()
      .mockResolvedValueOnce(diagnosticStatus)
      .mockResolvedValue({
        ...diagnosticStatus,
        bufferedEventCount: 4,
        writeFailureCount: 2,
      });
    installBridge({ getDiagnosticStatus });
    render(<SettingsPage />);
    await screen.findByText('已开启 · 默认脱敏');

    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));

    expect(await screen.findByText('写入降级 · 事件暂存在内存')).toBeInTheDocument();
    expect(screen.getByText('4 条')).toBeInTheDocument();
    expect(screen.getByText('2 次')).toBeInTheDocument();
    expect(getDiagnosticStatus).toHaveBeenCalledTimes(2);
  });

  it('exposes retries for status, directory, export, and clear failures', async () => {
    const getDiagnosticStatus = vi.fn()
      .mockRejectedValueOnce(new Error('status unavailable'))
      .mockResolvedValue(diagnosticStatus);
    const openDiagnosticDirectory = vi.fn().mockResolvedValue({
      opened: false,
      errorCode: 'SHELL_OPEN_FAILED',
    });
    const exportDiagnosticBundle = vi.fn().mockRejectedValue(new Error('export failed'));
    const clearDiagnosticLogs = vi.fn().mockRejectedValue(new Error('clear failed'));
    installBridge({
      getDiagnosticStatus,
      openDiagnosticDirectory,
      exportDiagnosticBundle,
      clearDiagnosticLogs,
    });

    render(<SettingsPage />);
    expect(await screen.findByText('诊断日志状态没有读取成功，请重试。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试日志检查' }));
    expect(await screen.findByText('/private/phrio-data/diagnostics')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '打开日志目录' }));
    expect(await screen.findByText('日志目录没有打开（SHELL_OPEN_FAILED），请重试。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '导出诊断包' }));
    expect(await screen.findByText('诊断包导出失败，请重试。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '清除诊断日志' }));
    expect(await screen.findByText('诊断日志清除未完成，磁盘上仍有 3 个日志文件，请重试。')).toBeInTheDocument();
  });

  it('does not claim success when files remain after a partial clear', async () => {
    const getDiagnosticStatus = vi.fn()
      .mockResolvedValueOnce(diagnosticStatus)
      .mockResolvedValue({
        ...diagnosticStatus,
        fileCount: 1,
        totalBytes: 512,
      });
    installBridge({ getDiagnosticStatus });
    render(<SettingsPage />);
    await screen.findByText('/private/phrio-data/diagnostics');

    fireEvent.click(screen.getByRole('button', { name: '清除诊断日志' }));

    expect(await screen.findByText('已清除 3 个日志文件，仍有 1 个文件未删除，请重试。')).toBeInTheDocument();
    expect(screen.queryByText('已清除 3 个诊断日志文件。')).not.toBeInTheDocument();
  });
});

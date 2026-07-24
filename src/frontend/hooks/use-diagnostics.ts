import { useCallback, useEffect, useRef, useState } from 'react';

import type { DiagnosticStatus } from '../../shared';
import {
  clearDiagnosticLogs,
  exportDiagnosticBundle,
  getDiagnosticStatus,
  openDiagnosticDirectory,
} from '../services/diagnostics-api';

export type DiagnosticLoadStatus = 'loading' | 'ready' | 'error';
export type DiagnosticOperation = 'open' | 'export' | 'clear' | null;
export type DiagnosticOperationStatus = 'idle' | 'pending' | 'success' | 'cancelled' | 'error';

export interface DiagnosticOperationState {
  readonly operation: DiagnosticOperation;
  readonly status: DiagnosticOperationStatus;
  readonly message: string;
}

const IDLE_OPERATION: DiagnosticOperationState = {
  operation: null,
  status: 'idle',
  message: '',
};

export function useDiagnostics() {
  const [status, setStatus] = useState<DiagnosticStatus | null>(null);
  const [loadStatus, setLoadStatus] = useState<DiagnosticLoadStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationState, setOperationState] = useState<DiagnosticOperationState>(IDLE_OPERATION);
  const mountedRef = useRef(true);
  const loadRevisionRef = useRef(0);
  const operationPendingRef = useRef(false);

  const refresh = useCallback(async (): Promise<DiagnosticStatus | null> => {
    const revision = ++loadRevisionRef.current;
    if (mountedRef.current) {
      setLoadStatus('loading');
      setLoadError(null);
    }
    try {
      const nextStatus = await getDiagnosticStatus();
      if (!mountedRef.current || revision !== loadRevisionRef.current) return null;
      setStatus(nextStatus);
      setLoadStatus('ready');
      return nextStatus;
    } catch {
      if (!mountedRef.current || revision !== loadRevisionRef.current) return null;
      setLoadStatus('error');
      setLoadError('诊断日志状态没有读取成功，请重试。');
      return null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      ++loadRevisionRef.current;
    };
  }, [refresh]);

  const beginOperation = useCallback((operation: Exclude<DiagnosticOperation, null>): boolean => {
    if (operationPendingRef.current) return false;
    operationPendingRef.current = true;
    setOperationState({ operation, status: 'pending', message: '' });
    return true;
  }, []);

  const finishOperation = useCallback((next: DiagnosticOperationState): void => {
    operationPendingRef.current = false;
    if (mountedRef.current) setOperationState(next);
  }, []);

  const openDirectory = useCallback(async (): Promise<void> => {
    if (!beginOperation('open')) return;
    try {
      const result = await openDiagnosticDirectory();
      if (!result.opened) {
        finishOperation({
          operation: 'open',
          status: 'error',
          message: result.errorCode
            ? `日志目录没有打开（${result.errorCode}），请重试。`
            : '日志目录没有打开，请重试。',
        });
        return;
      }
      finishOperation({ operation: 'open', status: 'success', message: '已在 Finder 中打开日志目录。' });
    } catch {
      finishOperation({ operation: 'open', status: 'error', message: '日志目录没有打开，请重试。' });
    }
  }, [beginOperation, finishOperation]);

  const exportBundle = useCallback(async (): Promise<void> => {
    if (!beginOperation('export')) return;
    try {
      const result = await exportDiagnosticBundle();
      if (result.cancelled) {
        finishOperation({ operation: 'export', status: 'cancelled', message: '已取消导出诊断包；本机日志没有改变。' });
        return;
      }
      if (!result.filePath) {
        finishOperation({ operation: 'export', status: 'error', message: '诊断包没有生成，请重试。' });
        return;
      }
      finishOperation({
        operation: 'export',
        status: 'success',
        message: `诊断包已导出到 ${result.filePath}（${result.eventCount} 条事件）。`,
      });
    } catch {
      finishOperation({ operation: 'export', status: 'error', message: '诊断包导出失败，请重试。' });
    }
  }, [beginOperation, finishOperation]);

  const clearLogs = useCallback(async (): Promise<void> => {
    if (!beginOperation('clear')) return;
    try {
      const result = await clearDiagnosticLogs();
      const refreshed = await refresh();
      if (!refreshed) {
        finishOperation({
          operation: 'clear',
          status: 'error',
          message: `已请求清除 ${result.deletedFileCount} 个日志文件，但无法确认目录状态，请重新检查。`,
        });
        return;
      }
      if (refreshed.fileCount > 0) {
        finishOperation({
          operation: 'clear',
          status: 'error',
          message: `已清除 ${result.deletedFileCount} 个日志文件，仍有 ${refreshed.fileCount} 个文件未删除，请重试。`,
        });
        return;
      }
      finishOperation({
        operation: 'clear',
        status: 'success',
        message: `已清除 ${result.deletedFileCount} 个诊断日志文件。`,
      });
    } catch {
      const refreshed = await refresh();
      finishOperation({
        operation: 'clear',
        status: 'error',
        message: refreshed && refreshed.fileCount > 0
          ? `诊断日志清除未完成，磁盘上仍有 ${refreshed.fileCount} 个日志文件，请重试。`
          : '诊断日志清除未完成，无法确认目录已经清空，请重试。',
      });
    }
  }, [beginOperation, finishOperation, refresh]);

  return {
    status,
    loadStatus,
    loadError,
    operationState,
    busy: operationState.status === 'pending',
    refresh,
    openDirectory,
    exportBundle,
    clearLogs,
  };
}

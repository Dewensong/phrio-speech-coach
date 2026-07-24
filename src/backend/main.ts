import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  powerSaveBlocker,
  protocol,
  session,
  shell,
} from 'electron';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createMainWindow,
  loadMainWindow,
  type CreateMainWindowOptions,
} from './config/create-main-window';
import {
  installRendererSecurity,
  PHRIO_RENDERER_SCHEME,
  registerRendererSchemePrivileges,
} from './config/renderer-security';
import { IpcController } from './controllers/ipc-controller';
import { AudioRepository } from './repositories/audio-repository';
import { SessionRepository } from './repositories/session-repository';
import { CloudAiRepository } from './repositories/cloud-ai-repository';
import { SecureAiKeyRepository } from './repositories/secure-ai-key-repository';
import { CloudAiService } from './services/cloud-ai-service';
import { PracticeSessionService } from './services/practice-session-service';
import { EnvironmentService } from './services/environment-service';
import { DiagnosticLogService } from './services/diagnostic-log-service';
import {
  createElectronSystemNetworkRequestGet,
} from './services/electron-system-network-request';
import {
  LocalAsrService,
  probeLocalAsrDependency,
} from './services/local-asr-service';
import { LocalAsrDirectDownloader } from './services/local-asr-direct-download';
import {
  LocalAsrModelInstaller,
  downloadOfficialLocalAsrModelArchive,
} from './services/local-asr-model-installer';
import { LocalAsrModelVerifier } from './services/local-asr-model-verifier';
import {
  LocalAsrInstallPowerSaveBlocker,
  type LocalAsrInstallPowerReleaseReason,
} from './services/local-asr-install-power-save-blocker';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

registerRendererSchemePrivileges(protocol);

let mainWindow: BrowserWindow | null = null;
let sessionRepository: SessionRepository | null = null;
let cloudAiRepository: CloudAiRepository | null = null;
let ipcController: IpcController | null = null;
let localAsrModelInstaller: LocalAsrModelInstaller | null = null;
let localAsrInstallPowerSaveBlocker: LocalAsrInstallPowerSaveBlocker | null = null;
let diagnosticLogService: DiagnosticLogService | null = null;
let diagnosticMaintenanceTimer: NodeJS.Timeout | null = null;
let desktopReady = false;
const DIAGNOSTIC_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000;
const MODEL_INSTALLER_SHUTDOWN_PAUSE_TIMEOUT_MS = 5_000;

type QuitState = 'idle' | 'pausing-model-install' | 'ready';

let quitState: QuitState = 'idle';

const packagedSmokeTest = process.argv.includes('--phrio-smoke-test');
const packagedAsrDependencySmokeTest = process.argv.includes(
  '--phrio-asr-dependency-smoke-test',
);
const smokeUserDataDirectory = packagedSmokeTest
  ? path.join(tmpdir(), `phrio-packaged-smoke-${process.pid}`)
  : null;

if (smokeUserDataDirectory) {
  mkdirSync(smokeUserDataDirectory, { recursive: true, mode: 0o700 });
  app.setPath('userData', smokeUserDataDirectory);
}

const ownsSingleInstanceLock =
  packagedSmokeTest ||
  packagedAsrDependencySmokeTest ||
  app.requestSingleInstanceLock();

function createDiagnosticLogService(): DiagnosticLogService {
  return new DiagnosticLogService(
    path.join(app.getPath('userData'), 'diagnostics'),
    { appVersion: app.getVersion() },
  );
}

function startDiagnosticMaintenance(): void {
  if (diagnosticMaintenanceTimer) return;
  diagnosticMaintenanceTimer = setInterval(() => {
    try {
      diagnosticLogService?.getStatus();
    } catch {
      // Maintenance shares the same fail-open boundary as event writes.
    }
  }, DIAGNOSTIC_MAINTENANCE_INTERVAL_MS);
  diagnosticMaintenanceTimer.unref();
}

function stopDiagnosticMaintenance(): void {
  if (!diagnosticMaintenanceTimer) return;
  clearInterval(diagnosticMaintenanceTimer);
  diagnosticMaintenanceTimer = null;
}

function recordDiagnostic(input: Parameters<DiagnosticLogService['record']>[0]): void {
  try {
    diagnosticLogService?.record(input);
  } catch {
    // Product execution must never depend on diagnostic storage.
  }
}

function recordDiagnosticError(
  component: Parameters<DiagnosticLogService['recordError']>[0]['component'],
  event: string,
  error: unknown,
  fields: Readonly<Record<string, unknown>> = {},
  level: 'error' | 'fatal' = 'error',
): void {
  try {
    diagnosticLogService?.recordError({ component, event, error, fields, level });
  } catch {
    // Product execution must never depend on diagnostic storage.
  }
}

function releaseLocalAsrInstallPowerSaveBlocker(
  reason: LocalAsrInstallPowerReleaseReason,
): void {
  const lease = localAsrInstallPowerSaveBlocker;
  if (!lease) return;
  try {
    if (lease.release(reason)) localAsrInstallPowerSaveBlocker = null;
  } catch (error) {
    // The production lease is fail-open; this remains a final defensive seam
    // so an injected implementation cannot prevent shutdown.
    recordDiagnosticError('asr', 'asr.model.power-save-blocker-release-failed', error, {
      reason,
      errorCode: 'ASR_MODEL_POWER_BLOCKER_RELEASE_FAILED',
    });
  }
}

function disposeApplicationResources(): void {
  let closeFailureCount = 0;
  try {
    ipcController?.dispose();
  } catch (error) {
    closeFailureCount += 1;
    recordDiagnosticError('ipc', 'ipc.shutdown-dispose-failed', error);
  } finally {
    ipcController = null;
  }
  releaseLocalAsrInstallPowerSaveBlocker('shutdown');
  localAsrModelInstaller = null;
  try {
    sessionRepository?.close();
  } catch (error) {
    closeFailureCount += 1;
    recordDiagnosticError('persistence', 'persistence.session-shutdown-close-failed', error);
  } finally {
    sessionRepository = null;
  }
  try {
    cloudAiRepository?.close();
  } catch (error) {
    closeFailureCount += 1;
    recordDiagnosticError('persistence', 'persistence.cloud-ai-shutdown-close-failed', error);
  } finally {
    cloudAiRepository = null;
  }
  stopDiagnosticMaintenance();
  recordDiagnostic({
    level: closeFailureCount === 0 ? 'info' : 'warn',
    component: 'app',
    event: 'app.quit-resources-closed',
    fields: { closeFailureCount },
  });
  try {
    diagnosticLogService?.getStatus();
  } catch {
    // Shutdown remains fail-open even if the final diagnostic flush fails.
  }
  diagnosticLogService = null;
}

function isModelInstallationActive(installer: LocalAsrModelInstaller): boolean {
  // The public status can reach a terminal stage before final workspace
  // cleanup and the power-blocker finally handler settle. The physical
  // promise is the authoritative shutdown boundary.
  return installer.hasActiveInstallation();
}

async function pauseModelInstallerForShutdown(
  installer: LocalAsrModelInstaller,
): Promise<void> {
  const startedAt = performance.now();
  let pauseTimedOut = false;
  let timeout: NodeJS.Timeout | null = null;
  recordDiagnostic({
    level: 'info',
    component: 'asr',
    event: 'asr.model.shutdown-pause-started',
    fields: { status: installer.getStatus().stage },
  });

  try {
    await Promise.race([
      installer.pauseForShutdown(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          pauseTimedOut = true;
          resolve();
        }, MODEL_INSTALLER_SHUTDOWN_PAUSE_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);
    const durationMs = Math.round(performance.now() - startedAt);
    recordDiagnostic({
      level: pauseTimedOut ? 'warn' : 'info',
      component: 'asr',
      event: pauseTimedOut
        ? 'asr.model.shutdown-pause-timeout'
        : 'asr.model.shutdown-pause-completed',
      fields: { durationMs },
    });
  } catch (error) {
    recordDiagnosticError('asr', 'asr.model.shutdown-pause-failed', error, {
      durationMs: Math.round(performance.now() - startedAt),
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

if (ownsSingleInstanceLock && !packagedAsrDependencySmokeTest) {
  diagnosticLogService = createDiagnosticLogService();
  startDiagnosticMaintenance();
  recordDiagnostic({
    level: 'info',
    component: 'app',
    event: 'app.launch',
    fields: {
      packaged: app.isPackaged,
      smokeTest: packagedSmokeTest,
    },
  });
}

process.on('uncaughtException', (error) => {
  recordDiagnosticError('app', 'app.uncaught-exception', error, {}, 'fatal');
  releaseLocalAsrInstallPowerSaveBlocker('fatal_exit');
  app.exit(1);
});

process.on('unhandledRejection', (reason) => {
  recordDiagnosticError('app', 'app.unhandled-rejection', reason);
});

app.on('render-process-gone', (_event, _webContents, details) => {
  recordDiagnostic({
    level: details.reason === 'clean-exit' ? 'info' : 'error',
    component: 'renderer',
    event: 'renderer.process-gone',
    fields: {
      reason: details.reason,
      exitCode: details.exitCode,
    },
  });
});

app.on('child-process-gone', (_event, details) => {
  recordDiagnostic({
    level: details.reason === 'clean-exit' ? 'info' : 'error',
    component: 'app',
    event: 'app.child-process-gone',
    fields: {
      processType: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    },
  });
});

async function runPackagedAsrDependencySmokeTest(): Promise<void> {
  await app.whenReady();
  try {
    const dependency = probeLocalAsrDependency();
    process.stdout.write(
      `PHRIO_PACKAGED_ASR_DEPENDENCY ${JSON.stringify({ loaded: true, ...dependency })}\n`,
    );
    app.exit(0);
  } catch (error) {
    process.stdout.write(
      `PHRIO_PACKAGED_ASR_DEPENDENCY ${JSON.stringify({
        loaded: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    app.exit(1);
  }
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

const windowOptions: CreateMainWindowOptions = {
  developmentServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
  rendererName: MAIN_WINDOW_VITE_NAME,
};

async function openMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return;
  }

  const window = createMainWindow(windowOptions);
  mainWindow = window;
  recordDiagnostic({
    level: 'info',
    component: 'window',
    event: 'window.created',
    fields: { windowCount: BrowserWindow.getAllWindows().length },
  });
  window.webContents.once('did-finish-load', () => {
    recordDiagnostic({
      level: 'info',
      component: 'window',
      event: 'window.renderer-loaded',
    });
  });
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, _errorDescription, validatedUrl, isMainFrame) => {
      recordDiagnostic({
        level: 'error',
        component: 'window',
        event: 'window.renderer-load-failed',
        fields: {
          errorCode,
          isMainFrame,
          protocol: getSafeProtocol(validatedUrl),
        },
      });
    },
  );
  window.on('unresponsive', () => {
    recordDiagnostic({
      level: 'warn',
      component: 'window',
      event: 'window.unresponsive',
    });
  });
  window.on('responsive', () => {
    recordDiagnostic({
      level: 'info',
      component: 'window',
      event: 'window.responsive',
    });
  });
  window.once('closed', () => {
    recordDiagnostic({
      level: 'info',
      component: 'window',
      event: 'window.closed',
    });
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  try {
    await loadMainWindow(window, windowOptions);
  } catch (error) {
    recordDiagnosticError('window', 'window.load-failed', error);
    throw error;
  }

  if (packagedSmokeTest) {
    const result = (await window.webContents.executeJavaScript(`(async () => {
      const hasBridge = typeof window.phrio === 'object';
      const bootstrap = hasBridge ? await window.phrio.getBootstrap() : null;
      return {
        hasBridge,
        bridgeMethods: hasBridge ? Object.keys(window.phrio).sort() : [],
        bootstrapModeCount: bootstrap?.modes?.length ?? 0,
        rendererHasNodeProcess: typeof window.process !== 'undefined',
        rendererProtocol: window.location.protocol
      };
    })()`)) as {
      readonly hasBridge: boolean;
      readonly bridgeMethods: readonly string[];
      readonly bootstrapModeCount: number;
      readonly rendererHasNodeProcess: boolean;
      readonly rendererProtocol: string;
    };

    ipcController?.dispose();
    ipcController = null;
    sessionRepository?.close();
    sessionRepository = null;
    cloudAiRepository?.close();
    cloudAiRepository = null;
    // No diagnostic should recreate the disposable smoke directory after its
    // cleanup starts.
    diagnosticLogService = null;
    stopDiagnosticMaintenance();
    window.destroy();
    if (smokeUserDataDirectory) {
      // The smoke already owns an isolated userData directory, so deleting it is
      // sufficient. Electron's clearStorageData() can wait indefinitely while the
      // default Session is still winding down; never let optional cleanup hang the
      // release gate. Chromium may finish a Session Storage write immediately after
      // the window closes, therefore directory cleanup remains best-effort.
      await rm(smokeUserDataDirectory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 100,
      }).catch(() => undefined);
    }
    process.stdout.write(`PHRIO_PACKAGED_SMOKE ${JSON.stringify(result)}\n`);
    app.exit(
      result.hasBridge &&
        result.bridgeMethods.length === 40 &&
        result.bootstrapModeCount === 3 &&
        !result.rendererHasNodeProcess &&
        result.rendererProtocol === `${PHRIO_RENDERER_SCHEME}:`
        ? 0
        : 1,
    );
  }
}

async function startApplication(): Promise<void> {
  await app.whenReady();
  recordDiagnostic({
    level: 'info',
    component: 'app',
    event: 'app.ready',
  });

  const userDataDirectory = app.getPath('userData');
  const diagnostics = diagnosticLogService ?? createDiagnosticLogService();
  diagnosticLogService = diagnostics;
  startDiagnosticMaintenance();
  recordDiagnostic({
    level: 'info',
    component: 'app',
    event: 'app.initialization-started',
  });
  sessionRepository = new SessionRepository(path.join(userDataDirectory, 'phrio.sqlite3'));
  const audioRepository = new AudioRepository(path.join(userDataDirectory, 'temporary-audio'));
  const practiceSessionService = new PracticeSessionService(
    sessionRepository,
    audioRepository,
  );
  await practiceSessionService.initialize();

  const rendererPolicy = installRendererSecurity({
    electronSession: session.defaultSession,
    getMainWindow: () => mainWindow,
    developmentServerUrl: windowOptions.developmentServerUrl,
    packagedRendererDirectory: path.join(
      __dirname,
      `../renderer/${windowOptions.rendererName}`,
    ),
    isPackaged: app.isPackaged,
  });

  const localAsrService = new LocalAsrService(
    path.join(userDataDirectory, 'models'),
    { diagnostics },
  );
  const localAsrModelVerifier = new LocalAsrModelVerifier(localAsrService.modelDirectory);
  const modelDownloadRequestGet = createElectronSystemNetworkRequestGet({
    request: (requestOptions) => net.request({
      ...requestOptions,
      session: session.defaultSession,
    }),
    onFirstRequest: ({ transport }) => {
      recordDiagnostic({
        level: 'info',
        component: 'asr',
        event: 'asr.model.download-transport-selected',
        fields: { transport },
      });
    },
  });
  localAsrInstallPowerSaveBlocker = new LocalAsrInstallPowerSaveBlocker({
    powerSaveBlocker: {
      start: (type) => powerSaveBlocker.start(type),
      isStarted: (id) => powerSaveBlocker.isStarted(id),
      stop: (id) => powerSaveBlocker.stop(id),
    },
    diagnostics,
  });
  localAsrModelInstaller = new LocalAsrModelInstaller(
    localAsrService.modelDirectory,
    {
      diagnostics,
      directDownloader: new LocalAsrDirectDownloader({
        requestGet: modelDownloadRequestGet,
      }),
      downloadArchive: (input) => downloadOfficialLocalAsrModelArchive({
        ...input,
        requestGet: modelDownloadRequestGet,
      }),
      verifyCandidateRuntime: async (candidateDirectory) => (
        await new LocalAsrModelVerifier(candidateDirectory).inspect()
      ).ready,
      installPowerLease: localAsrInstallPowerSaveBlocker,
    },
  );
  try {
    await localAsrModelInstaller.initialize();
  } catch (error) {
    // Stale model cleanup is retried by the explicit install action. It must not
    // turn a recoverable ASR environment problem into a blank application.
    recordDiagnosticError('asr', 'asr.model.startup-cleanup-failed', error);
  }
  cloudAiRepository = new CloudAiRepository(
    path.join(userDataDirectory, 'cloud-ai.sqlite3'),
  );
  const secureAiKeyRepository = new SecureAiKeyRepository(
    path.join(userDataDirectory, 'secure', 'openai-api-key.json'),
    {
      // macOS safeStorage may synchronously wait on an unavailable or locked
      // Keychain and freeze Electron's main thread. Phrio deliberately uses its
      // existing owner-only (0700/0600) local fallback so settings and AI setup
      // remain responsive. Legacy encrypted files stay deletable and are never
      // overwritten until the user explicitly saves a replacement key.
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error('SYSTEM_KEY_ENCRYPTION_DISABLED');
      },
      decryptString: () => {
        throw new Error('SYSTEM_KEY_ENCRYPTION_DISABLED');
      },
    },
  );
  const cloudAiService = new CloudAiService(
    cloudAiRepository,
    secureAiKeyRepository,
    {
      getPracticeSession: (sessionId) => practiceSessionService.getSession(sessionId),
      getAsrFinalSegments: (identity) => localAsrService.getFinalSegments(identity),
      releaseAsrAttemptLedger: (identity) => localAsrService.releaseAttemptLedger(identity),
      diagnostics,
    },
  );
  const environmentService = new EnvironmentService(
    practiceSessionService,
    localAsrService,
    userDataDirectory,
    {
      cloudDataGovernance: cloudAiRepository,
      cloudRequestLifecycle: cloudAiService,
      diagnosticDataGovernance: diagnostics,
      localAsrModelInstaller,
      localAsrModelVerifier,
    },
  );
  ipcController = new IpcController(
    ipcMain,
    practiceSessionService,
    localAsrService,
    environmentService,
    cloudAiService,
    rendererPolicy,
    diagnostics,
    {
      chooseExportPath: async () => {
        const options = {
          title: '导出 Phrio 诊断日志',
          defaultPath: `phrio-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        };
        const result = mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showSaveDialog(mainWindow, options)
          : await dialog.showSaveDialog(options);
        return result.canceled ? null : result.filePath;
      },
      openDirectory: (directoryPath) => shell.openPath(directoryPath),
    },
  );
  ipcController.register();
  desktopReady = true;
  recordDiagnostic({
    level: 'info',
    component: 'app',
    event: 'app.initialization-completed',
  });
  await openMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void openMainWindow().catch((error) => {
        recordDiagnosticError('window', 'window.activate-open-failed', error);
      });
    }
  });
}

app.on('window-all-closed', () => {
  recordDiagnostic({
    level: 'info',
    component: 'window',
    event: 'window.all-closed',
  });
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Idempotent final retry for release failures or exits that bypassed the
  // normal async pause path. Electron itself clears blockers at process exit.
  releaseLocalAsrInstallPowerSaveBlocker('will_quit');
});

app.on('before-quit', (event) => {
  if (quitState === 'ready') return;
  if (quitState === 'pausing-model-install') {
    event.preventDefault();
    return;
  }

  const installer = localAsrModelInstaller;
  recordDiagnostic({
    level: 'info',
    component: 'app',
    event: 'app.quit-started',
    fields: { status: installer?.getStatus().stage ?? 'unavailable' },
  });

  if (!installer || !isModelInstallationActive(installer)) {
    quitState = 'ready';
    disposeApplicationResources();
    return;
  }

  event.preventDefault();
  quitState = 'pausing-model-install';
  void pauseModelInstallerForShutdown(installer).finally(() => {
    try {
      disposeApplicationResources();
    } finally {
      quitState = 'ready';
      app.quit();
    }
  });
});

if (!ownsSingleInstanceLock) {
  app.quit();
} else if (packagedAsrDependencySmokeTest) {
  void runPackagedAsrDependencySmokeTest();
} else {
  if (!packagedSmokeTest) {
    app.on('second-instance', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        recordDiagnostic({
          level: 'info',
          component: 'app',
          event: 'app.second-instance',
        });
        focusMainWindow();
      } else if (desktopReady) {
        void openMainWindow().catch((error) => {
          recordDiagnosticError('window', 'window.second-instance-open-failed', error);
        });
      }
    });
  }
  void startApplication().catch((error) => {
    recordDiagnosticError('app', 'app.start-failed', error, {}, 'fatal');
    releaseLocalAsrInstallPowerSaveBlocker('fatal_exit');
    app.exit(1);
  });
}

function getSafeProtocol(value: string): string {
  try {
    return new URL(value).protocol;
  } catch {
    return 'unknown';
  }
}

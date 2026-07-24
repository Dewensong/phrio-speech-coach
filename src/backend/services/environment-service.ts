import path from 'node:path';

import type {
  ClearDiagnosticLogsOutput,
  ClearTrainingDataOutput,
  DiagnosticLogClearSummary,
  GetLocalAsrModelInstallStatusOutput,
  GetEnvironmentStatusOutput,
  InstallLocalAsrModelOutput,
  ResetNonSensitiveSettingsOutput,
} from '../../shared';
import { DiagnosticLogClearError } from './diagnostic-log-service';
import { LocalAsrService } from './local-asr-service';
import { LocalAsrModelInstaller } from './local-asr-model-installer';
import {
  LocalAsrModelVerifier,
  type LocalAsrModelVerification,
} from './local-asr-model-verifier';
import { PracticeSessionService } from './practice-session-service';

interface LocalAsrModelVerifierPort {
  inspect(): Promise<LocalAsrModelVerification>;
}

export interface EnvironmentServiceOptions {
  readonly now?: () => Date;
  readonly localAsrModelInstaller?: LocalAsrModelInstaller;
  readonly localAsrModelVerifier?: LocalAsrModelVerifierPort;
  readonly cloudDataGovernance?: {
    deleteTrainingAuditData(): void;
    deleteSessionAuditData?(sessionId: string, attemptIds: readonly string[]): void;
    resetConsentData(): void;
  };
  readonly cloudRequestLifecycle?: {
    runWithTrainingDataReset<T>(operation: () => Promise<T> | T): Promise<T>;
    runWithSessionDataDeletion?<T>(
      scope: { readonly sessionId: string; readonly attemptIds: readonly string[] },
      operation: () => Promise<T> | T,
    ): Promise<T>;
  };
  readonly diagnosticDataGovernance?: {
    clear(): ClearDiagnosticLogsOutput;
  };
}

/** Coordinates environment inspection and tightly scoped local data governance. */
export class EnvironmentService {
  readonly #practice: PracticeSessionService;
  readonly #localAsr: LocalAsrService;
  readonly #dataDirectory: string;
  readonly #now: () => Date;
  readonly #localAsrModelInstaller: LocalAsrModelInstaller;
  readonly #localAsrModelVerifier: LocalAsrModelVerifierPort;
  readonly #cloudDataGovernance: EnvironmentServiceOptions['cloudDataGovernance'];
  readonly #cloudRequestLifecycle: EnvironmentServiceOptions['cloudRequestLifecycle'];
  readonly #diagnosticDataGovernance: EnvironmentServiceOptions['diagnosticDataGovernance'];

  constructor(
    practice: PracticeSessionService,
    localAsr: LocalAsrService,
    dataDirectory: string,
    options: EnvironmentServiceOptions = {},
  ) {
    this.#practice = practice;
    this.#localAsr = localAsr;
    this.#dataDirectory = path.resolve(dataDirectory);
    this.#now = options.now ?? (() => new Date());
    this.#localAsrModelInstaller = options.localAsrModelInstaller
      ?? new LocalAsrModelInstaller(localAsr.modelDirectory, { now: this.#now });
    this.#localAsrModelVerifier = options.localAsrModelVerifier
      ?? new LocalAsrModelVerifier(localAsr.modelDirectory);
    this.#cloudDataGovernance = options.cloudDataGovernance;
    this.#cloudRequestLifecycle = options.cloudRequestLifecycle;
    this.#diagnosticDataGovernance = options.diagnosticDataGovernance;
  }

  async getStatus(): Promise<GetEnvironmentStatusOutput> {
    const localAsr = await this.#localAsrModelVerifier.inspect();
    return {
      checkedAt: this.#now().toISOString(),
      dataDirectory: this.#dataDirectory,
      trainingRecordCount: this.#practice.countTrainingRecords(),
      localAsr: {
        state: localAsr.state,
        ready: localAsr.ready,
        files: [...localAsr.files],
      },
    };
  }

  async installLocalAsrModel(): Promise<InstallLocalAsrModelOutput> {
    return this.#localAsrModelInstaller.install();
  }

  getLocalAsrModelInstallStatus(): GetLocalAsrModelInstallStatusOutput {
    return this.#localAsrModelInstaller.getStatus();
  }

  cancelLocalAsrModelInstallation(): boolean {
    return this.#localAsrModelInstaller.cancel();
  }

  async clearTrainingData(): Promise<ClearTrainingDataOutput> {
    this.#localAsr.cancel();
    const clear = async (): Promise<ClearTrainingDataOutput> => {
      // Privacy-first: if cloud deletion fails, the still-reachable local graph
      // remains available for an explicit retry. If local audio cleanup fails
      // later, exact cloud payloads and audit data are already gone.
      this.#cloudDataGovernance?.deleteTrainingAuditData();
      const deletedTrainingRecordCount = await this.#practice.clearTrainingData();
      const diagnosticLogs = this.#clearDiagnosticLogs();
      return {
        trainingDataCleared: true,
        deletedTrainingRecordCount,
        diagnosticLogs,
        modelsPreserved: true,
        externalExportsPreserved: true,
        otherUserDataPreserved: true,
      };
    };
    return this.#cloudRequestLifecycle
      ? this.#cloudRequestLifecycle.runWithTrainingDataReset(clear)
      : clear();
  }

  #clearDiagnosticLogs(): DiagnosticLogClearSummary {
    if (!this.#diagnosticDataGovernance) {
      return {
        status: 'cleared',
        deletedFileCount: 0,
        deletedBytes: 0,
        remainingFileCount: 0,
        remainingBytes: 0,
      };
    }
    try {
      const result = this.#diagnosticDataGovernance.clear();
      return {
        status: 'cleared',
        ...result,
        remainingFileCount: 0,
        remainingBytes: 0,
      };
    } catch (error) {
      if (error instanceof DiagnosticLogClearError) {
        return {
          status: 'retry_required',
          deletedFileCount: error.deletedFileCount,
          deletedBytes: error.deletedBytes,
          remainingFileCount: error.remainingFileCount,
          remainingBytes: error.remainingBytes,
        };
      }
      return {
        status: 'retry_required',
        deletedFileCount: 0,
        deletedBytes: 0,
        remainingFileCount: null,
        remainingBytes: null,
      };
    }
  }

  async deletePracticeSession(sessionId: string): Promise<boolean> {
    const session = this.#practice.getSession(sessionId);
    const attemptIds = session?.attempts.map((attempt) => attempt.id) ?? [];
    const remove = async (): Promise<boolean> => {
      // Privacy-first ordering: exact cloud payloads and consent/audit metadata
      // disappear before the parent Session can become unreachable locally.
      this.#cloudDataGovernance?.deleteSessionAuditData?.(sessionId, attemptIds);
      return this.#practice.deleteSession(sessionId);
    };
    return this.#cloudRequestLifecycle?.runWithSessionDataDeletion
      ? this.#cloudRequestLifecycle.runWithSessionDataDeletion(
        { sessionId, attemptIds },
        remove,
      )
      : remove();
  }

  async resetNonSensitiveSettings(): Promise<ResetNonSensitiveSettingsOutput> {
    const reset = (): ResetNonSensitiveSettingsOutput => {
      this.#practice.supersedePendingCloudArtifactsForConsentReset();
      this.#cloudDataGovernance?.resetConsentData();
      return this.#practice.resetNonSensitivePreferences();
    };
    return this.#cloudRequestLifecycle
      ? this.#cloudRequestLifecycle.runWithTrainingDataReset(reset)
      : reset();
  }
}

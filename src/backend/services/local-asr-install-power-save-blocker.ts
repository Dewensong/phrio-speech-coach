import type { RecordDiagnosticEventInput } from '../../shared';

const BLOCKER_TYPE = 'prevent-app-suspension' as const;
const MAXIMUM_RELEASE_ATTEMPTS = 3;

export type LocalAsrInstallPowerReleaseReason =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'shutdown'
  | 'fatal_exit'
  | 'will_quit'
  | 'unknown';

export interface LocalAsrInstallPowerLease {
  acquire(): boolean;
  release(reason: LocalAsrInstallPowerReleaseReason): boolean;
}

export interface PowerSaveBlockerPort {
  start(type: typeof BLOCKER_TYPE): number;
  isStarted(id: number): boolean;
  stop(id: number): boolean;
}

export interface LocalAsrInstallPowerSaveBlockerOptions {
  readonly powerSaveBlocker: PowerSaveBlockerPort;
  readonly diagnostics?: {
    record(input: RecordDiagnosticEventInput): unknown;
  };
}

/**
 * Owns one transient Electron power-save blocker while a physical model
 * installation promise is active. It never changes persistent OS power
 * settings, and every Electron/diagnostic call is fail-open for installation.
 */
export class LocalAsrInstallPowerSaveBlocker implements LocalAsrInstallPowerLease {
  readonly #powerSaveBlocker: PowerSaveBlockerPort;
  readonly #diagnostics: LocalAsrInstallPowerSaveBlockerOptions['diagnostics'];
  #blockerId: number | null = null;

  constructor(options: LocalAsrInstallPowerSaveBlockerOptions) {
    this.#powerSaveBlocker = options.powerSaveBlocker;
    this.#diagnostics = options.diagnostics;
  }

  acquire(): boolean {
    const existingId = this.#blockerId;
    if (existingId !== null) {
      const existingState = this.#isStarted(existingId, 'acquire_reuse');
      if (existingState !== false) return true;
      this.#blockerId = null;
    }

    let blockerId: number;
    try {
      blockerId = this.#powerSaveBlocker.start(BLOCKER_TYPE);
      if (!Number.isSafeInteger(blockerId) || blockerId < 0) {
        throw new TypeError('powerSaveBlocker.start returned an invalid id');
      }
      // Keep ownership before probing state so a failed state check can still
      // be followed by a deterministic stop at the terminal boundary.
      this.#blockerId = blockerId;
    } catch {
      this.#record({
        level: 'warn',
        component: 'asr',
        event: 'asr.model.power-save-blocker-acquire-failed',
        fields: {
          blockerType: BLOCKER_TYPE,
          errorCode: 'ASR_MODEL_POWER_BLOCKER_START_FAILED',
        },
      });
      return false;
    }

    const started = this.#isStarted(blockerId, 'acquire_verify');
    if (started === false) {
      this.#blockerId = null;
      this.#record({
        level: 'warn',
        component: 'asr',
        event: 'asr.model.power-save-blocker-acquire-failed',
        fields: {
          blockerType: BLOCKER_TYPE,
          blockerId,
          errorCode: 'ASR_MODEL_POWER_BLOCKER_NOT_STARTED',
        },
      });
      return false;
    }

    this.#record({
      level: 'info',
      component: 'asr',
      event: 'asr.model.power-save-blocker-acquired',
      fields: {
        blockerType: BLOCKER_TYPE,
        blockerId,
        verified: started === true,
      },
    });
    return true;
  }

  release(reason: LocalAsrInstallPowerReleaseReason): boolean {
    const blockerId = this.#blockerId;
    if (blockerId === null) return true;

    for (let attempt = 1; attempt <= MAXIMUM_RELEASE_ATTEMPTS; attempt += 1) {
      const startedBeforeStop = this.#isStarted(
        blockerId,
        attempt === 1 ? 'release_verify' : 'release_retry_verify',
      );
      if (startedBeforeStop === false) {
        this.#blockerId = null;
        this.#recordReleased(blockerId, reason, attempt, false, true);
        return true;
      }

      let stopped = false;
      let stopErrorCode = 'ASR_MODEL_POWER_BLOCKER_STOP_REJECTED';
      try {
        stopped = this.#powerSaveBlocker.stop(blockerId);
      } catch {
        stopErrorCode = 'ASR_MODEL_POWER_BLOCKER_STOP_FAILED';
      }
      const startedAfterStop = this.#isStarted(blockerId, 'release_post_stop');

      // isStarted=false is authoritative even if stop returned false/threw.
      // If the post-check itself fails, Electron's stop=true contract is the
      // strongest available evidence and still prevents retaining a stale id.
      if (startedAfterStop === false || (stopped && startedAfterStop === null)) {
        this.#blockerId = null;
        this.#recordReleased(
          blockerId,
          reason,
          attempt,
          true,
          startedAfterStop === false,
        );
        return true;
      }

      if (stopped && startedAfterStop === true) {
        stopErrorCode = 'ASR_MODEL_POWER_BLOCKER_STILL_STARTED';
      }
      this.#record({
        level: 'warn',
        component: 'asr',
        event: 'asr.model.power-save-blocker-release-failed',
        fields: {
          blockerType: BLOCKER_TYPE,
          blockerId,
          reason,
          attempt,
          maximumAttempts: MAXIMUM_RELEASE_ATTEMPTS,
          errorCode: stopErrorCode,
        },
      });
    }

    // Retain the id so dispose/will-quit can make one final bounded retry.
    return false;
  }

  #isStarted(
    blockerId: number,
    requestPhase:
      | 'acquire_reuse'
      | 'acquire_verify'
      | 'release_verify'
      | 'release_retry_verify'
      | 'release_post_stop',
  ): boolean | null {
    try {
      return this.#powerSaveBlocker.isStarted(blockerId);
    } catch {
      this.#record({
        level: 'warn',
        component: 'asr',
        event: 'asr.model.power-save-blocker-state-check-failed',
        fields: {
          blockerType: BLOCKER_TYPE,
          blockerId,
          requestPhase,
          errorCode: 'ASR_MODEL_POWER_BLOCKER_STATE_CHECK_FAILED',
        },
      });
      return null;
    }
  }

  #recordReleased(
    blockerId: number,
    reason: LocalAsrInstallPowerReleaseReason,
    releaseAttempts: number,
    wasStarted: boolean,
    verified: boolean,
  ): void {
    this.#record({
      level: 'info',
      component: 'asr',
      event: 'asr.model.power-save-blocker-released',
      fields: {
        blockerType: BLOCKER_TYPE,
        blockerId,
        reason,
        releaseAttempts,
        wasStarted,
        verified,
      },
    });
  }

  #record(input: RecordDiagnosticEventInput): void {
    try {
      this.#diagnostics?.record(input);
    } catch {
      // Diagnostics must never break the blocker or the installation lifecycle.
    }
  }
}

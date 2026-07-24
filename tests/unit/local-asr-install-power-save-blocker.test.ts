// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  LocalAsrInstallPowerSaveBlocker,
  type PowerSaveBlockerPort,
} from '../../src/backend/services/local-asr-install-power-save-blocker';

describe('LocalAsrInstallPowerSaveBlocker', () => {
  it('owns one prevent-app-suspension blocker and releases it idempotently', () => {
    const active = new Set<number>();
    const powerSaveBlocker = {
      start: vi.fn((type: 'prevent-app-suspension') => {
        expect(type).toBe('prevent-app-suspension');
        active.add(41);
        return 41;
      }),
      isStarted: vi.fn((id: number) => active.has(id)),
      stop: vi.fn((id: number) => active.delete(id)),
    } satisfies PowerSaveBlockerPort;
    const diagnostics = { record: vi.fn() };
    const lease = new LocalAsrInstallPowerSaveBlocker({ powerSaveBlocker, diagnostics });

    expect(lease.acquire()).toBe(true);
    expect(lease.acquire()).toBe(true);
    expect(powerSaveBlocker.start).toHaveBeenCalledOnce();
    expect(active.has(41)).toBe(true);
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.power-save-blocker-acquired',
      fields: expect.objectContaining({
        blockerType: 'prevent-app-suspension',
        blockerId: 41,
        verified: true,
      }),
    }));

    expect(lease.release('completed')).toBe(true);
    expect(lease.release('completed')).toBe(true);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
    expect(active.has(41)).toBe(false);
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.power-save-blocker-released',
      fields: expect.objectContaining({ reason: 'completed', wasStarted: true }),
    }));
  });

  it('fails open when Electron cannot start a blocker', () => {
    const diagnostics = { record: vi.fn() };
    const lease = new LocalAsrInstallPowerSaveBlocker({
      powerSaveBlocker: {
        start: vi.fn(() => { throw new Error('native start failed'); }),
        isStarted: vi.fn(),
        stop: vi.fn(),
      },
      diagnostics,
    });

    expect(lease.acquire()).toBe(false);
    expect(lease.release('failed')).toBe(true);
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.power-save-blocker-acquire-failed',
      fields: expect.objectContaining({
        errorCode: 'ASR_MODEL_POWER_BLOCKER_START_FAILED',
      }),
    }));
  });

  it('retains ownership when isStarted fails and still stops at the terminal boundary', () => {
    const stop = vi.fn(() => true);
    const diagnostics = { record: vi.fn() };
    const lease = new LocalAsrInstallPowerSaveBlocker({
      powerSaveBlocker: {
        start: vi.fn(() => 7),
        isStarted: vi.fn(() => { throw new Error('native state check failed'); }),
        stop,
      },
      diagnostics,
    });

    expect(lease.acquire()).toBe(true);
    expect(lease.release('cancelled')).toBe(true);
    expect(stop).toHaveBeenCalledExactlyOnceWith(7);
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.power-save-blocker-state-check-failed',
      fields: expect.objectContaining({
        errorCode: 'ASR_MODEL_POWER_BLOCKER_STATE_CHECK_FAILED',
      }),
    }));
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.power-save-blocker-released',
      fields: expect.objectContaining({ reason: 'cancelled' }),
    }));
  });

  it('retries a thrown stop call inside the same bounded release without reacquiring', () => {
    let stopAttempt = 0;
    let active = true;
    const stop = vi.fn(() => {
      stopAttempt += 1;
      if (stopAttempt === 1) throw new Error('native stop failed');
      active = false;
      return true;
    });
    const diagnostics = { record: vi.fn() };
    const lease = new LocalAsrInstallPowerSaveBlocker({
      powerSaveBlocker: {
        start: vi.fn(() => 19),
        isStarted: vi.fn(() => active),
        stop,
      },
      diagnostics,
    });

    expect(lease.acquire()).toBe(true);
    expect(lease.release('failed')).toBe(true);
    expect(lease.release('will_quit')).toBe(true);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.power-save-blocker-release-failed',
      fields: expect.objectContaining({
        reason: 'failed',
        errorCode: 'ASR_MODEL_POWER_BLOCKER_STOP_FAILED',
      }),
    }));
  });

  it('retries Electron stop=false inside the same bounded release', () => {
    let active = true;
    const stop = vi.fn(() => {
      if (stop.mock.calls.length === 1) return false;
      active = false;
      return true;
    });
    const diagnostics = { record: vi.fn() };
    const lease = new LocalAsrInstallPowerSaveBlocker({
      powerSaveBlocker: {
        start: vi.fn(() => 23),
        isStarted: vi.fn(() => active),
        stop,
      },
      diagnostics,
    });

    expect(lease.acquire()).toBe(true);
    expect(lease.release('failed')).toBe(true);
    expect(lease.release('will_quit')).toBe(true);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(diagnostics.record).toHaveBeenCalledWith(expect.objectContaining({
      event: 'asr.model.power-save-blocker-release-failed',
      fields: expect.objectContaining({
        reason: 'failed',
        errorCode: 'ASR_MODEL_POWER_BLOCKER_STOP_REJECTED',
      }),
    }));
  });

  it('bounds persistent stop rejection to three attempts without an infinite retry timer', () => {
    const stop = vi.fn(() => false);
    const diagnostics = { record: vi.fn() };
    const lease = new LocalAsrInstallPowerSaveBlocker({
      powerSaveBlocker: {
        start: vi.fn(() => 29),
        isStarted: vi.fn(() => true),
        stop,
      },
      diagnostics,
    });

    expect(lease.acquire()).toBe(true);
    expect(lease.release('failed')).toBe(false);
    expect(stop).toHaveBeenCalledTimes(3);
    expect(diagnostics.record.mock.calls.filter(([input]) => (
      input.event === 'asr.model.power-save-blocker-release-failed'
    ))).toHaveLength(3);
  });

  it('keeps installation control fail-open when diagnostic storage throws', () => {
    const active = new Set<number>();
    const lease = new LocalAsrInstallPowerSaveBlocker({
      powerSaveBlocker: {
        start: () => {
          active.add(3);
          return 3;
        },
        isStarted: (id) => active.has(id),
        stop: (id) => active.delete(id),
      },
      diagnostics: {
        record: () => { throw new Error('diagnostic storage failed'); },
      },
    });

    expect(lease.acquire()).toBe(true);
    expect(lease.release('completed')).toBe(true);
    expect(active.size).toBe(0);
  });
});

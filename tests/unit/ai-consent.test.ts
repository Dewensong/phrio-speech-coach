import { describe, expect, it } from 'vitest';

import { canSendAiPayload, type AiConsent } from '../../src/shared';

const approvedAt = '2026-07-17T04:00:00.000Z';
const base: AiConsent = {
  id: 'consent-1', purpose: 'live_hint', scope: 'configuration', payloadHash: null,
  approvedFields: ['finalSegments.text'], approvedAt, revokedAt: null,
};

describe('AI payload consent boundary', () => {
  it('requires both configuration consent and per-attempt AI ON for live hints', () => {
    expect(canSendAiPayload({ purpose: 'live_hint', payloadHash: '1234567890abcdef', consent: base, explicitAttemptAiOn: false })).toBe(false);
    expect(canSendAiPayload({ purpose: 'live_hint', payloadHash: '1234567890abcdef', consent: base, explicitAttemptAiOn: true })).toBe(true);
  });

  it('binds deep diagnosis and comparison approval to the exact payload hash', () => {
    const deep: AiConsent = { ...base, purpose: 'deep_diagnosis', scope: 'payload', payloadHash: '1234567890abcdef' };
    expect(canSendAiPayload({ purpose: 'deep_diagnosis', payloadHash: '1234567890abcdef', consent: deep })).toBe(true);
    expect(canSendAiPayload({ purpose: 'deep_diagnosis', payloadHash: 'fedcba0987654321', consent: deep })).toBe(false);
  });
});

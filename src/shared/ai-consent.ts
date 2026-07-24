import { z } from 'zod';

const Identifier = z.string().min(1).max(160);
const IsoDate = z.string().datetime({ offset: true });

export const AiPurposeSchema = z.enum(['live_hint', 'deep_diagnosis', 'comparison']);
export type AiPurpose = z.infer<typeof AiPurposeSchema>;

export const AiConsentSchema = z.object({
  id: Identifier,
  purpose: AiPurposeSchema,
  scope: z.enum(['configuration', 'payload']),
  payloadHash: z.string().min(16).max(128).nullable(),
  approvedFields: z.array(z.string().min(1).max(120)).min(1),
  approvedAt: IsoDate,
  revokedAt: IsoDate.nullable(),
}).strict().superRefine((value, context) => {
  if (value.purpose === 'live_hint' && value.scope !== 'configuration') {
    context.addIssue({ code: 'custom', message: 'live_hint requires configuration consent', path: ['scope'] });
  }
  if (value.purpose !== 'live_hint' && (value.scope !== 'payload' || !value.payloadHash)) {
    context.addIssue({ code: 'custom', message: 'deep payloads require hash-bound consent', path: ['payloadHash'] });
  }
});
export type AiConsent = z.infer<typeof AiConsentSchema>;

export const CloudRequestMetadataSchema = z.object({
  id: Identifier,
  attemptId: Identifier,
  purpose: AiPurposeSchema,
  payloadHash: z.string().min(16).max(128),
  consentId: Identifier,
  requestedAt: IsoDate,
  completedAt: IsoDate.nullable(),
  status: z.enum(['queued', 'processing', 'completed', 'failed', 'discarded']),
  rawAudioIncluded: z.literal(false),
}).strict();
export type CloudRequestMetadata = z.infer<typeof CloudRequestMetadataSchema>;

/** Consent is deliberately checked at the last transport boundary. */
export function canSendAiPayload(input: {
  readonly purpose: AiPurpose;
  readonly payloadHash: string;
  readonly consent: AiConsent | null;
  readonly explicitAttemptAiOn?: boolean;
}): boolean {
  if (!input.consent) return false;
  const consent = AiConsentSchema.parse(input.consent);
  if (consent.revokedAt || consent.purpose !== input.purpose) return false;
  if (input.purpose === 'live_hint') return input.explicitAttemptAiOn === true;
  return consent.payloadHash === input.payloadHash;
}

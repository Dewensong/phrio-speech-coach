import {
  APPROVED_LIVE_AI_POLICY,
  type AppSettings,
  type CloudAiConfigurationStatus,
  type CloudAiConsent,
  type CloudAiConsentStatus,
  type CloudAiPurpose,
  type DeepDiagnosisPayload,
  type DeepDiagnosisResponse,
  type LiveHintPayload,
  type LiveHintResponse,
  type PreparedAiConsent,
  type SemanticComparisonPayload,
  type SemanticComparisonResponse,
  type SetLiveAttemptAiStateInput,
  type SetLiveAttemptAiStateOutput,
} from '../../shared';

export {
  buildDeepDiagnosisPayload,
  buildSemanticComparisonPayload,
  parseEditedComparisonPayload,
  parseEditedDeepPayload,
  taskContextForCloudAi,
} from '../../shared';

export const PHRIO_LIVE_AI_POLICY = APPROVED_LIVE_AI_POLICY;

function bridge() {
  if ('phrio' in window) return window.phrio;
  throw new Error('PHRIO_DESKTOP_BRIDGE_UNAVAILABLE');
}

export async function getCloudAiConfiguration(): Promise<CloudAiConfigurationStatus> {
  return bridge().getCloudAiConfiguration();
}

export async function saveCloudAiKey(apiKey: string): Promise<CloudAiConfigurationStatus> {
  return bridge().saveCloudAiKey({ apiKey });
}

export async function deleteCloudAiKey(): Promise<CloudAiConfigurationStatus> {
  return bridge().deleteCloudAiKey();
}

export async function getCloudAiConsentStatus(
  purpose: CloudAiPurpose,
): Promise<CloudAiConsentStatus> {
  return bridge().getCloudAiConsentStatus({ purpose });
}

export async function prepareLiveHintConsent(): Promise<PreparedAiConsent> {
  return bridge().prepareAiConsent({
    purpose: 'live_hint',
    policy: PHRIO_LIVE_AI_POLICY,
  });
}

export async function prepareDeepDiagnosisConsent(
  payload: DeepDiagnosisPayload,
): Promise<PreparedAiConsent> {
  return bridge().prepareAiConsent({ purpose: 'deep_diagnosis', payload });
}

export async function prepareComparisonConsent(
  payload: SemanticComparisonPayload,
): Promise<PreparedAiConsent> {
  return bridge().prepareAiConsent({ purpose: 'comparison', payload });
}

export async function approvePreparedConsent(prepared: PreparedAiConsent): Promise<CloudAiConsent> {
  return bridge().approveAiConsent({
    preparationId: prepared.preparationId,
    purpose: prepared.purpose,
    payloadHash: prepared.payloadHash,
    policyHash: prepared.policyHash,
    approvedFields: prepared.approvedFields,
  });
}

export async function revokeCloudAiConsent(consentId: string): Promise<CloudAiConsent> {
  return bridge().revokeAiConsent({ consentId });
}

export function setLiveAttemptAiState(
  input: SetLiveAttemptAiStateInput,
): Promise<SetLiveAttemptAiStateOutput> {
  return bridge().setLiveAttemptAiState(input);
}

export async function executeLiveHint(
  payload: LiveHintPayload,
  consentId: string,
): Promise<LiveHintResponse> {
  return bridge().executeLiveHint({ payload, consentId, explicitAttemptAiOn: true });
}

export async function cancelLiveHint(attemptId: string): Promise<void> {
  return bridge().cancelLiveHint({ attemptId }).then(() => undefined);
}

export async function executeDeepDiagnosis(
  payload: DeepDiagnosisPayload,
  consentId: string,
): Promise<DeepDiagnosisResponse> {
  return bridge().executeDeepDiagnosis({ payload, consentId });
}

export async function executeSemanticComparison(
  payload: SemanticComparisonPayload,
  consentId: string,
): Promise<SemanticComparisonResponse> {
  return bridge().executeSemanticComparison({ payload, consentId });
}

export async function getCloudAiPreferences(): Promise<AppSettings['cloudAi']> {
  return bridge().getSettings().then((settings) => settings.cloudAi);
}

export async function updateCloudAiPreferences(
  cloudAi: AppSettings['cloudAi'],
): Promise<AppSettings['cloudAi']> {
  return bridge().updateSettings({ cloudAi }).then((settings) => settings.cloudAi);
}

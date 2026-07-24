import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LiveAiSetup } from '../../src/frontend/components/live-ai-setup';
import {
  APPROVED_AI_PROVIDER,
  APPROVED_LIVE_AI_POLICY,
  DEFAULT_APP_SETTINGS,
  type PhrioDesktopApi,
} from '../../src/shared';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'phrio');
});

describe('live AI inline setup', () => {
  it('allows direct key setup when only the private-file fallback is available', async () => {
    const fallbackConfiguration = {
      provider: 'openai' as const,
      providerName: 'OpenAI' as const,
      model: APPROVED_AI_PROVIDER.model,
      endpoint: APPROVED_AI_PROVIDER.endpoint,
      protocolVersion: APPROVED_AI_PROVIDER.protocolVersion,
      configured: false,
      encryptionAvailable: false,
      keyStorage: 'local_private_file_unencrypted' as const,
      keyHint: null,
      retentionNotice: APPROVED_AI_PROVIDER.retentionNotice,
    };
    const saveCloudAiKey = vi.fn().mockResolvedValue({
      ...fallbackConfiguration,
      configured: true,
      keyHint: '••••7890',
    });
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getCloudAiConfiguration: vi.fn().mockResolvedValue(fallbackConfiguration),
        saveCloudAiKey,
        getSettings: vi.fn().mockResolvedValue(DEFAULT_APP_SETTINGS),
        getCloudAiConsentStatus: vi.fn().mockResolvedValue({
          purpose: 'live_hint',
          active: false,
          consent: null,
        }),
      } as unknown as PhrioDesktopApi,
    });

    render(<LiveAiSetup onCancel={vi.fn()} onReady={vi.fn()} />);

    const input = await screen.findByLabelText('OpenAI API Key');
    expect(screen.getByText(/为保持应用响应，将写入仅当前用户可读的本机私有文件/)).toBeInTheDocument();
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute('placeholder', '保存在本机私有文件（未加密）');
    fireEvent.change(input, { target: { value: 'test-openai-fallback-key-1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 Key 并继续' }));
    await waitFor(() => expect(saveCloudAiKey).toHaveBeenCalledWith({
      apiKey: 'test-openai-fallback-key-1234567890',
    }));
  });

  it('turns a previously disabled control into an explicit key, consent, purpose, and per-attempt ON flow', async () => {
    let configured = false;
    let consentApproved = false;
    let preferences = { ...DEFAULT_APP_SETTINGS.cloudAi, liveHintEnabled: false };
    const prepared = {
      preparationId: 'preparation-live-inline',
      purpose: 'live_hint' as const,
      scope: 'configuration' as const,
      provider: 'openai' as const,
      model: APPROVED_AI_PROVIDER.model,
      endpoint: APPROVED_AI_PROVIDER.endpoint,
      payloadHash: null,
      policyHash: 'a'.repeat(64),
      schemaVersion: APPROVED_LIVE_AI_POLICY.policyVersion,
      promptVersion: APPROVED_AI_PROVIDER.promptVersion,
      approvedFields: [...APPROVED_LIVE_AI_POLICY.sentFieldPaths],
      previewJson: JSON.stringify(APPROVED_LIVE_AI_POLICY),
      retentionNotice: APPROVED_AI_PROVIDER.retentionNotice,
      preparedAt: '2026-07-20T00:00:00.000Z',
    };
    const consent = {
      id: 'consent-live-inline',
      purpose: 'live_hint' as const,
      scope: 'configuration' as const,
      sessionId: null,
      provider: 'openai' as const,
      model: APPROVED_AI_PROVIDER.model,
      endpoint: APPROVED_AI_PROVIDER.endpoint,
      payloadHash: null,
      policyHash: prepared.policyHash,
      schemaVersion: prepared.schemaVersion,
      promptVersion: APPROVED_AI_PROVIDER.promptVersion,
      approvedFields: prepared.approvedFields,
      approvedAt: '2026-07-20T00:01:00.000Z',
      expiresAt: null,
      revokedAt: null,
    };
    const saveCloudAiKey = vi.fn(async () => {
      configured = true;
      return configurationStatus();
    });
    const approveAiConsent = vi.fn(async () => {
      consentApproved = true;
      return consent;
    });
    const updateSettings = vi.fn(async (patch: { cloudAi: typeof preferences }) => {
      preferences = patch.cloudAi;
      return { ...DEFAULT_APP_SETTINGS, cloudAi: preferences };
    });
    function configurationStatus() {
      return {
        provider: 'openai' as const,
        providerName: 'OpenAI' as const,
        model: APPROVED_AI_PROVIDER.model,
        endpoint: APPROVED_AI_PROVIDER.endpoint,
        protocolVersion: APPROVED_AI_PROVIDER.protocolVersion,
        configured,
        encryptionAvailable: true,
        keyStorage: 'system_encrypted' as const,
        keyHint: configured ? '••••test' : null,
        retentionNotice: APPROVED_AI_PROVIDER.retentionNotice,
      };
    }
    Object.defineProperty(window, 'phrio', {
      configurable: true,
      value: {
        getCloudAiConfiguration: vi.fn(async () => configurationStatus()),
        saveCloudAiKey,
        getSettings: vi.fn(async () => ({ ...DEFAULT_APP_SETTINGS, cloudAi: preferences })),
        updateSettings,
        getCloudAiConsentStatus: vi.fn(async () => ({
          purpose: 'live_hint' as const,
          active: consentApproved,
          consent: consentApproved ? consent : null,
        })),
        prepareAiConsent: vi.fn().mockResolvedValue(prepared),
        approveAiConsent,
      } as unknown as PhrioDesktopApi,
    });
    const onReady = vi.fn();
    const onCancel = vi.fn();

    render(<LiveAiSetup onCancel={onCancel} onReady={onReady} />);

    const keyInput = await screen.findByLabelText('OpenAI API Key');
    const saveButton = screen.getByRole('button', { name: '保存 Key 并继续' });
    expect(keyInput).toHaveFocus();
    expect(keyInput).toHaveAccessibleDescription(/Key 至少 20 个字符/);
    expect(saveButton).toBeDisabled();
    fireEvent.keyDown(keyInput, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();

    fireEvent.change(keyInput, {
      target: { value: 'test-openai-key-12345678901234567890' },
    });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);
    await waitFor(() => expect(saveCloudAiKey).toHaveBeenCalledWith({
      apiKey: 'test-openai-key-12345678901234567890',
    }));

    const viewConsent = await screen.findByRole('button', { name: '查看配置级同意' });
    await waitFor(() => expect(viewConsent).toHaveFocus());
    fireEvent.click(viewConsent);
    const approveConsent = await screen.findByRole('button', { name: '批准此配置' });
    await waitFor(() => expect(approveConsent).toHaveFocus());
    fireEvent.click(approveConsent);
    await waitFor(() => expect(approveAiConsent).toHaveBeenCalledWith(expect.objectContaining({
      preparationId: prepared.preparationId,
      purpose: 'live_hint',
    })));

    const enablePurpose = await screen.findByRole('button', { name: '开启实时短提示' });
    await waitFor(() => expect(enablePurpose).toHaveFocus());
    fireEvent.click(enablePurpose);
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      cloudAi: { ...DEFAULT_APP_SETTINGS.cloudAi, liveHintEnabled: true },
    }));
    await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  });
});

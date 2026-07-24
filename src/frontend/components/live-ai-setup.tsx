import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { AppSettings, CloudAiConfigurationStatus, PreparedAiConsent } from '../../shared';
import {
  approvePreparedConsent,
  getCloudAiConfiguration,
  getCloudAiConsentStatus,
  getCloudAiPreferences,
  prepareLiveHintConsent,
  saveCloudAiKey,
  updateCloudAiPreferences,
} from '../services/cloud-ai-api';

type SetupStep = 'loading' | 'key' | 'consent' | 'purpose' | 'ready' | 'error';

interface LiveAiSetupProps {
  readonly onCancel: () => void;
  readonly onReady: () => Promise<boolean | void> | boolean | void;
}

export function LiveAiSetup({ onCancel, onReady }: LiveAiSetupProps) {
  const [step, setStep] = useState<SetupStep>('loading');
  const [apiKey, setApiKey] = useState('');
  const [keyStorage, setKeyStorage] = useState<CloudAiConfigurationStatus['keyStorage']>('system_encrypted');
  const [preferences, setPreferences] = useState<AppSettings['cloudAi'] | null>(null);
  const [preparedConsent, setPreparedConsent] = useState<PreparedAiConsent | null>(null);
  const [message, setMessage] = useState('正在检查实时 AI 配置…');
  const operationRevision = useRef(0);
  const mounted = useRef(true);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const stepActionRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async (): Promise<SetupStep> => {
    const revision = ++operationRevision.current;
    setStep('loading');
    setMessage('正在检查实时 AI 配置…');
    try {
      const [configuration, nextPreferences, consent] = await Promise.all([
        getCloudAiConfiguration(),
        getCloudAiPreferences(),
        getCloudAiConsentStatus('live_hint'),
      ]);
      const nextStep: SetupStep = !configuration.configured
        ? 'key'
        : !consent.active || !consent.consent
          ? 'consent'
          : !nextPreferences.liveHintEnabled
            ? 'purpose'
            : 'ready';
      if (!mounted.current || revision !== operationRevision.current) return nextStep;
      setKeyStorage(configuration.keyStorage);
      setPreferences(nextPreferences);
      setStep(nextStep);
      setMessage(nextStep === 'ready'
        ? '配置已就绪；仍需为本次练习显式打开 AI。'
        : nextStep === 'key'
          ? configuration.keyStorage === 'system_encrypted'
            ? '先保存 OpenAI API Key；将写入本机系统加密存储。'
            : '先保存 OpenAI API Key；为保持应用响应，将写入仅当前用户可读的本机私有文件（未加密）。'
          : nextStep === 'consent'
            ? '请查看并批准 live_hint 配置级同意。'
            : '最后开启“实时短提示”用途。');
      return nextStep;
    } catch {
      if (mounted.current && revision === operationRevision.current) {
        setStep('error');
        setMessage('实时 AI 配置读取失败，请重试。');
      }
      return 'error';
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      operationRevision.current += 1;
    };
  }, [refresh]);

  useLayoutEffect(() => {
    if (step === 'loading') return;
    const target = step === 'key' ? keyInputRef.current : stepActionRef.current;
    target?.focus({ preventScroll: true });
  }, [preparedConsent, step]);

  const saveKey = async () => {
    const revision = ++operationRevision.current;
    setStep('loading');
    setMessage(keyStorage === 'system_encrypted'
      ? '正在写入系统加密存储…'
      : '正在写入本机私有文件（未加密）…');
    try {
      const configuration = await saveCloudAiKey(apiKey.trim());
      if (!mounted.current || revision !== operationRevision.current) return;
      setKeyStorage(configuration.keyStorage);
      setApiKey('');
      await refresh();
    } catch {
      if (!mounted.current || revision !== operationRevision.current) return;
      setStep('key');
      setMessage('API Key 没有保存成功，请检查格式后重试。');
    }
  };

  const prepareConsent = async () => {
    const revision = ++operationRevision.current;
    setStep('loading');
    setMessage('正在生成配置级同意预览…');
    try {
      const prepared = await prepareLiveHintConsent();
      if (!mounted.current || revision !== operationRevision.current) return;
      setPreparedConsent(prepared);
      setStep('consent');
      setMessage('仅 final 累计文本与冻结任务会进入短提示请求；音频和 partial 不会发送。');
    } catch {
      if (!mounted.current || revision !== operationRevision.current) return;
      setStep('consent');
      setMessage('同意预览生成失败，请重试。');
    }
  };

  const approveConsent = async () => {
    if (!preparedConsent) return;
    const revision = ++operationRevision.current;
    setStep('loading');
    setMessage('正在保存配置级同意…');
    try {
      await approvePreparedConsent(preparedConsent);
      if (!mounted.current || revision !== operationRevision.current) return;
      setPreparedConsent(null);
      await refresh();
    } catch {
      if (!mounted.current || revision !== operationRevision.current) return;
      setStep('consent');
      setMessage('配置级同意未保存，请重新生成预览后重试。');
    }
  };

  const enablePurpose = async () => {
    if (!preferences) return;
    const revision = ++operationRevision.current;
    setStep('loading');
    setMessage('正在开启实时短提示用途…');
    try {
      await updateCloudAiPreferences({ ...preferences, liveHintEnabled: true });
      if (!mounted.current || revision !== operationRevision.current) return;
      const nextStep = await refresh();
      if (nextStep === 'ready' && mounted.current) await activateForAttempt();
    } catch {
      if (!mounted.current || revision !== operationRevision.current) return;
      setStep('purpose');
      setMessage('实时短提示用途没有保存成功，请重试。');
    }
  };

  const activateForAttempt = async () => {
    const revision = ++operationRevision.current;
    setStep('loading');
    setMessage('正在为本次练习建立 AI 实时通道…');
    try {
      const activated = await onReady();
      if (!mounted.current || revision !== operationRevision.current) return;
      if (activated === false) {
        setStep('ready');
        setMessage('配置已保存，但本轮 AI 通道尚未建立；请重试本次开启。');
      }
    } catch {
      if (!mounted.current || revision !== operationRevision.current) return;
      setStep('ready');
      setMessage('本次练习的 AI 开关未能开启，请重试。');
    }
  };

  return (
    <section
      aria-busy={step === 'loading'}
      aria-label="设置实时 AI"
      className="live-ai-setup"
      id="live-ai-setup-panel"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <header>
        <strong>设置实时 AI</strong>
        <button className="text-button" onClick={onCancel} type="button">关闭</button>
      </header>
      <p aria-live="polite" role="status">{message}</p>

      {step === 'key' ? (
        <div className="live-ai-setup-row">
          <label htmlFor="live-ai-api-key">OpenAI API Key</label>
          <input
            aria-describedby="live-ai-key-hint"
            autoComplete="new-password"
            id="live-ai-api-key"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={keyStorage === 'system_encrypted'
              ? '保存在本机系统加密存储'
              : '保存在本机私有文件（未加密）'}
            ref={keyInputRef}
            type="password"
            value={apiKey}
          />
          <button className="secondary-button" disabled={apiKey.trim().length < 20} onClick={() => void saveKey()} type="button">保存 Key 并继续</button>
          <small id="live-ai-key-hint">
            Key 至少 20 个字符；未达到前不会写入。{keyStorage === 'local_private_file_unencrypted'
              ? ' 当前文件仅允许本机用户读取（0600）。'
              : ''}
          </small>
        </div>
      ) : null}

      {step === 'consent' && !preparedConsent ? (
        <button className="secondary-button" onClick={() => void prepareConsent()} ref={stepActionRef} type="button">查看配置级同意</button>
      ) : null}
      {step === 'consent' && preparedConsent ? (
        <div className="live-ai-consent-preview">
          <pre tabIndex={0}>{preparedConsent.previewJson}</pre>
          <p>{preparedConsent.retentionNotice}</p>
          <button className="secondary-button" onClick={() => void approveConsent()} ref={stepActionRef} type="button">批准此配置</button>
        </div>
      ) : null}
      {step === 'purpose' ? (
        <button className="secondary-button" onClick={() => void enablePurpose()} ref={stepActionRef} type="button">开启实时短提示</button>
      ) : null}
      {step === 'ready' ? (
        <button className="primary-button" onClick={() => void activateForAttempt()} ref={stepActionRef} type="button">为本次练习打开 AI</button>
      ) : null}
      {step === 'error' ? (
        <button className="secondary-button" onClick={() => void refresh()} ref={stepActionRef} type="button">重新检查</button>
      ) : null}
    </section>
  );
}

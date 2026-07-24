import { HardDrive, Mic2, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  getAudioRetentionPreference,
  setAudioRetentionPreference,
  type AudioRetentionPreference,
} from '../services/desktop-api';

type AudioRetentionListener = (preference: AudioRetentionPreference) => void;

let audioRetentionOperationTail: Promise<void> = Promise.resolve();
const audioRetentionListeners = new Set<AudioRetentionListener>();

function enqueueAudioRetentionOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = audioRetentionOperationTail.then(operation);
  audioRetentionOperationTail = result.then(() => undefined, () => undefined);
  return result;
}

function readAudioRetentionPreference(): Promise<AudioRetentionPreference> {
  return enqueueAudioRetentionOperation(() => getAudioRetentionPreference());
}

function persistAudioRetentionPreference(
  preference: AudioRetentionPreference,
): Promise<AudioRetentionPreference> {
  return enqueueAudioRetentionOperation(async () => {
    const persisted = await setAudioRetentionPreference(preference);
    for (const listener of audioRetentionListeners) listener(persisted);
    return persisted;
  });
}

function subscribeToAudioRetention(listener: AudioRetentionListener): () => void {
  audioRetentionListeners.add(listener);
  return () => audioRetentionListeners.delete(listener);
}

export function PracticeSettingsPage() {
  const [audioRetention, setAudioRetention] = useState<AudioRetentionPreference>('delete_on_complete');
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const saveRevision = useRef(0);
  const pendingSaveRevision = useRef<number | null>(null);
  const persistedRetention = useRef<AudioRetentionPreference>('delete_on_complete');
  const savedTimeout = useRef<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    const unsubscribe = subscribeToAudioRetention((preference) => {
      persistedRetention.current = preference;
      if (pendingSaveRevision.current === null) {
        setAudioRetention(preference);
        setSaveError(undefined);
      }
    });
    void readAudioRetentionPreference()
      .then((preference) => {
        if (!active) return;
        persistedRetention.current = preference;
        if (pendingSaveRevision.current === null) setAudioRetention(preference);
      })
      .catch(() => {
        if (active && pendingSaveRevision.current === null) {
          setSaveError('暂时无法读取音频保存设置。');
        }
      });
    return () => {
      active = false;
      mounted.current = false;
      unsubscribe();
      if (savedTimeout.current !== null) window.clearTimeout(savedTimeout.current);
    };
  }, []);

  const updateRetention = (next: AudioRetentionPreference) => {
    const revision = ++saveRevision.current;
    pendingSaveRevision.current = revision;
    if (savedTimeout.current !== null) {
      window.clearTimeout(savedTimeout.current);
      savedTimeout.current = null;
    }
    setAudioRetention(next);
    setSaved(false);
    setSaveError(undefined);
    void persistAudioRetentionPreference(next)
      .then((persisted) => {
        if (!mounted.current || revision !== saveRevision.current) return;
        pendingSaveRevision.current = null;
        persistedRetention.current = persisted;
        setAudioRetention(persisted);
        setSaved(true);
        savedTimeout.current = window.setTimeout(() => {
          if (!mounted.current || revision !== saveRevision.current) return;
          setSaved(false);
          savedTimeout.current = null;
        }, 1_600);
      })
      .catch(() => {
        if (!mounted.current || revision !== saveRevision.current) return;
        pendingSaveRevision.current = null;
        setAudioRetention(persistedRetention.current);
        setSaveError('没有保存成功，已恢复本机中上一次保存的设置。');
      });
  };

  return (
    <section className="practice-settings-page">
      <header>
        <span className="settings-folio" aria-hidden="true">REHEARSAL RULES · 03</span>
        <h1>练习设置</h1>
        <p>这些是练习行为与保存边界；模式和任务在每次开始前选择。</p>
      </header>

      <section className="practice-setting-card">
        <header><HardDrive aria-hidden="true" size={18} /><div><h2>完成后的原始音频</h2><p>逐字稿、证据与练习结果仍按 Session 保存在本机。</p></div></header>
        <label>
          <input
            checked={audioRetention === 'delete_on_complete'}
            name="audio-retention"
            onChange={() => updateRetention('delete_on_complete')}
            type="radio"
          />
          <span><strong>完成后删除原始音频</strong><small>推荐；保留冻结逐字稿、证据与比较。</small></span>
        </label>
        <label>
          <input
            checked={audioRetention === 'keep_with_session'}
            name="audio-retention"
            onChange={() => updateRetention('keep_with_session')}
            type="radio"
          />
          <span><strong>随本次练习保存在本机</strong><small>删除 Session 时会一并级联清理。</small></span>
        </label>
        <footer aria-live="polite">{saveError ?? (saved ? '已保存到本机' : '更改会自动保存')}</footer>
      </section>

      <section className="practice-setting-card practice-setting-summary">
        <header><Mic2 aria-hidden="true" size={18} /><div><h2>开始边界</h2><p>麦克风只在你主动开始录音后请求；Attempt 开始后模式冻结。</p></div></header>
        <header><ShieldCheck aria-hidden="true" size={18} /><div><h2>AI 用途</h2><p>实时提示每次仍需 AI ON；深度诊断和比较逐 payload 批准。</p></div></header>
      </section>
    </section>
  );
}

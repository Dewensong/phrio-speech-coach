import {
  CheckCircle2,
  Cpu,
  HardDrive,
  Mic2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

interface FirstRunPageProps {
  onContinue: () => void;
  onTryDemo: () => void;
  busy?: boolean;
  error?: string;
}

export function FirstRunPage({
  onContinue,
  onTryDemo,
  busy = false,
  error,
}: FirstRunPageProps) {
  return (
    <div className="screen-grid onboarding-grid">
      <section className="main-pane onboarding-main">
        <div className="page-heading">
          <p className="eyebrow">本地优先 · 无账号</p>
          <h1>先看清楚，什么会留在本机</h1>
          <p>
            Phrio 是练习空间，不替你生成表达。录音、本地转写、逐字稿和练习记录
            默认留在这台设备；任何出域分析都必须先经过与你的用途相匹配的同意。
          </p>
        </div>

        <div className="boundary-list">
          <article>
            <span className="boundary-icon"><Mic2 size={18} /></span>
            <div>
              <h2>录音与回放</h2>
              <p>只在你主动开始后采集；可回放、重录或删除。</p>
            </div>
            <span className="quiet-badge">默认本机</span>
          </article>
          <article>
            <span className="boundary-icon"><Cpu size={18} /></span>
            <div>
              <h2>练习闭环</h2>
              <p>初讲、Drill、复讲与保存都不依赖云端账号。</p>
            </div>
            <span className="quiet-badge">无需 AI</span>
          </article>
          <article>
            <span className="boundary-icon"><Sparkles size={18} /></span>
            <div>
              <h2>可选 AI 增强</h2>
              <p>实时短提示、深度诊断和比较是三个独立用途；未配置或未批准时不发送。</p>
            </div>
            <span className="quiet-badge">默认关闭</span>
          </article>
          <article>
            <span className="boundary-icon"><HardDrive size={18} /></span>
            <div>
              <h2>音频生命周期</h2>
              <p>未完成练习可暂存；完成、重录或删除时按规则清理。</p>
            </div>
            <span className="quiet-badge">可控制</span>
          </article>
        </div>

        <div className="information-strip">
          <ShieldCheck aria-hidden="true" size={17} />
          Phrio 不需要账号，也不包含遥测。口述音频不会作为 AI 请求上传；文本出域前会显示用途和范围。
        </div>

        <section className="onboarding-demo-callout" aria-labelledby="onboarding-demo-title">
          <div className="demo-callout-mark"><Sparkles aria-hidden="true" size={20} /></div>
          <div>
            <p className="eyebrow">先看效果，再决定是否准备真实环境</p>
            <h2 id="onboarding-demo-title">用 30 秒看完初讲、诊断、焦点与前后对比</h2>
            <p>固定演示文本，不请求麦克风、不安装约 226.2 MiB 的本地模型，也不会产生练习记录。</p>
          </div>
          <button className="secondary-button" onClick={onTryDemo} type="button">
            体验受控演示
          </button>
        </section>

        <div className="page-actions end-aligned">
          {error ? <p className="inline-error" role="alert">{error}</p> : null}
          <button
            className="primary-button"
            disabled={busy}
            onClick={onContinue}
            type="button"
          >
            {busy ? '正在保存…' : '了解并进入练习'}
          </button>
        </div>
      </section>

      <aside className="inspector onboarding-inspector">
        <header className="inspector-header">
          <strong>环境边界</strong>
          <span>3 项</span>
        </header>
        <div className="check-list">
          <div>
            <CheckCircle2 size={18} />
            <span><strong>麦克风</strong><small>仅在开始录音时请求</small></span>
          </div>
          <div>
            <CheckCircle2 size={18} />
            <span><strong>本地存储</strong><small>Session 与音频留在设备</small></span>
          </div>
          <div>
            <CheckCircle2 size={18} />
            <span><strong>网络与 AI</strong><small>默认本地；逐用途批准后才可发送文本</small></span>
          </div>
        </div>
        <div className="inspector-note">
          第一次点击“开始录音”时，macOS 可能显示系统权限提示。
        </div>
      </aside>
    </div>
  );
}

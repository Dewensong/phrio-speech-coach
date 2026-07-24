import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Eye,
  MicOff,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';

interface DemoExperiencePageProps {
  readonly onExit: () => void;
  readonly onStartRealPractice: () => void;
}

const DEMO_STAGES = [
  { label: '初讲证据', hint: '看见原句' },
  { label: '诊断焦点', hint: '只练一件事' },
  { label: '同口径对比', hint: '确认是否变化' },
] as const;

const initialSentences = [
  '我觉得这周可能还是先把版本稳一下。',
  '然后新增需求这件事，我们后面再看看。',
] as const;

const retrySentences = [
  '我的建议是本周冻结新增需求。',
  '产品与研发今天确认冻结范围，周五依据阻塞项清零情况重新评估。',
] as const;

export function DemoExperiencePage({
  onExit,
  onStartRealPractice,
}: DemoExperiencePageProps) {
  const [stage, setStage] = useState(0);

  return (
    <div className="demo-experience">
      <header className="demo-hero">
        <div>
          <button className="text-button" onClick={onExit} type="button">
            <ArrowLeft aria-hidden="true" size={15} />返回
          </button>
          <span className="demo-edition-stamp" aria-hidden="true">FIXTURE EDITION · 01</span>
          <p className="eyebrow"><Sparkles aria-hidden="true" size={13} />30 秒受控演示</p>
          <h1>先看见一次“再说一遍，会更清楚”</h1>
          <p>
            这条演示使用固定文本呈现完整方法，不请求麦克风、不安装模型、
            不创建练习记录，也不会调用云端 AI。
          </p>
        </div>
        <div className="demo-trust-card" aria-label="演示数据边界">
          <MicOff aria-hidden="true" size={20} />
          <strong>无需授权</strong>
          <span>演示数据 · 不冒充真实设备结果</span>
        </div>
      </header>

      <ol className="demo-stage-rail" aria-label="演示进度">
        {DEMO_STAGES.map((item, index) => (
          <li
            aria-current={stage === index ? 'step' : undefined}
            className={stage === index ? 'is-current' : stage > index ? 'is-complete' : ''}
            key={item.label}
          >
            <span>{stage > index ? <CheckCircle2 size={16} /> : index + 1}</span>
            <div><strong>{item.label}</strong><small>{item.hint}</small></div>
          </li>
        ))}
      </ol>

      <main className="demo-stage-canvas">
        {stage === 0 ? (
          <section className="demo-transcript-stage" aria-labelledby="demo-initial-title">
            <div className="demo-stage-copy">
              <p className="eyebrow">Step 1 · 冻结原句</p>
              <h2 id="demo-initial-title">反馈必须回到你真的说过什么</h2>
              <p>这里只标记已经落定的 final；临时 partial 不会进入历史或诊断。</p>
            </div>
            <div className="demo-evidence-layout">
              <article className="demo-transcript-card" data-folio="PROOF · 01">
                <header><span>初讲 · 2 个 final 句段</span><span>受控演示</span></header>
                <p>{initialSentences[0]}</p>
                <p>
                  然后新增需求这件事，我们
                  <mark>后面再看看</mark>
                  <button aria-label="定位证据 O1" type="button">O1</button>。
                </p>
              </article>
              <article className="demo-evidence-card" data-folio="EVIDENCE · O1">
                <span>O1</span>
                <div>
                  <strong>任务缺口 · 已确认</strong>
                  <blockquote>“后面再看看”</blockquote>
                  <p>听众仍不知道要冻结什么、由谁确认，以及何时重新评估。</p>
                </div>
              </article>
            </div>
          </section>
        ) : null}

        {stage === 1 ? (
          <section className="demo-diagnosis-stage" aria-labelledby="demo-diagnosis-title" data-folio="DIAGNOSIS · 01">
            <header>
              <div>
                <p className="eyebrow">Step 2 · 本地确定性诊断</p>
                <h2 id="demo-diagnosis-title">本轮最需要先处理的一件事</h2>
              </div>
              <span><ShieldCheck size={14} />固定演示规则</span>
            </header>
            <div className="demo-diagnosis-conclusion">
              <span>一句话结论</span>
              <p>听众还不知道本周要冻结什么、谁在何时确认下一步。</p>
            </div>
            <div className="demo-diagnosis-body">
              <article>
                <span>01 · 判断证据</span>
                <blockquote>“后面再看看”没有形成可执行的决策请求。</blockquote>
              </article>
              <article className="is-focus">
                <span>02 · 唯一焦点</span>
                <h3>结论、决策或请求</h3>
                <p>成功标准：听众能用一句话复述需要决定、同意或执行什么。</p>
              </article>
            </div>
            <div className="demo-drill">
              <span>短 Drill</span>
              <p>今天只需要确认一件事：______。</p>
            </div>
          </section>
        ) : null}

        {stage === 2 ? (
          <section className="demo-comparison-stage" aria-labelledby="demo-comparison-title" data-folio="PAIRED PROOF · 01">
            <header>
              <div>
                <p className="eyebrow">Step 3 · 同一口径前后比较</p>
                <h2 id="demo-comparison-title">目标行为更清楚</h2>
              </div>
              <span>不生成总分</span>
            </header>
            <div className="demo-comparison-grid">
              <article data-folio="TAKE · 01">
                <span>初讲</span>
                {initialSentences.map((sentence) => <p key={sentence}>{sentence}</p>)}
                <small>结论：证据不足</small>
              </article>
              <ArrowRight aria-hidden="true" size={22} />
              <article className="is-retry" data-folio="TAKE · 02">
                <span>复讲</span>
                {retrySentences.map((sentence) => <p key={sentence}>{sentence}</p>)}
                <small>结论：已出现明确决定与复评条件</small>
              </article>
            </div>
            <div className="demo-criterion">
              <Eye aria-hidden="true" size={16} />
              <div>
                <span>本轮只比较</span>
                <strong>听众是否明确知道要决定、同意或执行什么</strong>
              </div>
            </div>
          </section>
        ) : null}
      </main>

      <footer className="demo-actions">
        <p><ShieldCheck aria-hidden="true" size={14} />演示不会写入“最近练习”或训练数据。</p>
        <div>
          {stage > 0 ? (
            <button className="secondary-button" onClick={() => setStage((value) => value - 1)} type="button">
              上一步
            </button>
          ) : null}
          {stage < DEMO_STAGES.length - 1 ? (
            <button className="primary-button" onClick={() => setStage((value) => value + 1)} type="button">
              继续演示<ArrowRight aria-hidden="true" size={15} />
            </button>
          ) : (
            <>
              <button className="secondary-button" onClick={() => setStage(0)} type="button">
                <RotateCcw aria-hidden="true" size={15} />重新演示
              </button>
              <button className="primary-button" onClick={onStartRealPractice} type="button">
                开始真实练习<ArrowRight aria-hidden="true" size={15} />
              </button>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}

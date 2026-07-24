import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ShareResultDialog } from '../../src/frontend/components/share-result-dialog';
import { DemoExperiencePage } from '../../src/frontend/pages/demo-experience-page';
import {
  buildShareCardMarkdown,
  buildShareCardSvg,
  type ShareCardData,
} from '../../src/frontend/services/share-card';

const shareData: ShareCardData = {
  title: '说明为什么本周应冻结新增需求',
  conclusion: '听众还不知道本周要冻结什么、谁在何时确认下一步。',
  evidence: '后面再看看',
  focus: '结论、决策或请求',
  successCondition: '听众能用一句话复述需要决定、同意或执行什么。',
  comparison: '目标行为更清楚',
  comparisonDetail: '复讲出现了明确决定与复评条件。',
  createdAt: '2026/07/23',
};

describe('propagation experience', () => {
  it('walks through a clearly labelled controlled demo without requesting real capabilities', () => {
    const onExit = vi.fn();
    const onStartRealPractice = vi.fn();
    render(
      <DemoExperiencePage
        onExit={onExit}
        onStartRealPractice={onStartRealPractice}
      />,
    );

    expect(screen.getByText('30 秒受控演示')).toBeTruthy();
    expect(screen.getByText(/不请求麦克风、不安装模型/)).toBeTruthy();
    expect(document.querySelector('.demo-edition-stamp')).toHaveTextContent('FIXTURE EDITION · 01');
    expect(screen.getByText('反馈必须回到你真的说过什么')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /继续演示/ }));
    expect(screen.getByText('本轮最需要先处理的一件事')).toBeTruthy();
    expect(screen.getByText('结论、决策或请求')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /继续演示/ }));
    expect(screen.getByText('目标行为更清楚')).toBeTruthy();
    expect(screen.getByText('不生成总分')).toBeTruthy();
    expect(screen.getByText(/演示不会写入“最近练习”/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /开始真实练习/ }));
    expect(onStartRealPractice).toHaveBeenCalledOnce();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('keeps evidence redacted by default and exports only the selected result fields', () => {
    const withoutEvidence = buildShareCardSvg(shareData, {
      aspect: 'landscape',
      includeEvidence: false,
    });
    const withEvidence = buildShareCardSvg(shareData, {
      aspect: 'portrait',
      includeEvidence: true,
    });
    const markdown = buildShareCardMarkdown(shareData, {
      aspect: 'square',
      includeEvidence: false,
    });

    expect(withoutEvidence).not.toContain('后面再看看');
    expect(withoutEvidence).toContain('不含完整逐字稿');
    expect(withoutEvidence).toContain('不生成总分');
    expect(withoutEvidence).toContain('RESULT PROOF · 01 · LOCAL');
    expect(withoutEvidence).toContain('rx="0"');
    expect(withoutEvidence).not.toContain('rx="24"');
    expect(withEvidence).toContain('后面再看看');
    expect(withEvidence).toContain('width="1080"');
    expect(markdown).not.toContain('后面再看看');
    expect(markdown).toContain('目标行为更清楚');
  });

  it('keeps every content section inside all three share-card canvases', () => {
    const longData: ShareCardData = {
      ...shareData,
      conclusion: shareData.conclusion.repeat(6),
      evidence: shareData.evidence?.repeat(12) ?? null,
      successCondition: shareData.successCondition.repeat(8),
      comparisonDetail: shareData.comparisonDetail?.repeat(8) ?? null,
    };
    const dimensions = {
      landscape: { width: 1600, height: 1000 },
      square: { width: 1200, height: 1200 },
      portrait: { width: 1080, height: 1920 },
    } as const;

    for (const [aspect, dimension] of Object.entries(dimensions)) {
      const svg = buildShareCardSvg(longData, {
        aspect: aspect as keyof typeof dimensions,
        includeEvidence: true,
      });
      const sections = [...svg.matchAll(
        /<rect class="section(?: accent)?" x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"/g,
      )];
      const heroLines = [...svg.matchAll(/<text class="hero"/g)];
      expect(svg).toContain(`width="${dimension.width}"`);
      expect(sections).toHaveLength(3);
      expect(svg.match(/class="section-rule"/gu)).toHaveLength(3);
      expect(heroLines.length).toBeGreaterThan(1);
      expect(svg).not.toMatch(/<text class="(?:hero|section-body)"[^>]*>[，。！？；：、）】》”’…]/u);
      expect(sections.every((section) => (
        Number(section[1]) + Number(section[2]) < dimension.height
      ))).toBe(true);
    }
  });

  it('presents local-only export controls and makes source evidence opt-in', () => {
    render(<ShareResultDialog data={shareData} onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: '展示与分享练习结果' });
    expect(dialog).toBeTruthy();
    expect(screen.getByText('本地生成 · 不自动上传')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /加入关键证据原句/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: /导出 PNG/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /导出 SVG/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /导出 Markdown/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /纯净展示模式/ }));
    expect(screen.getByText('按 Esc 退出纯净展示')).toBeTruthy();
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(dialog).toHaveFocus();
  });
});

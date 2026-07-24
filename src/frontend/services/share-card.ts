export type ShareCardAspect = 'landscape' | 'square' | 'portrait';
export type ShareCardFormat = 'png' | 'svg' | 'markdown';

export interface ShareCardData {
  readonly title: string;
  readonly conclusion: string;
  readonly evidence: string | null;
  readonly focus: string;
  readonly successCondition: string;
  readonly comparison: string | null;
  readonly comparisonDetail: string | null;
  readonly createdAt: string;
}

export interface ShareCardOptions {
  readonly aspect: ShareCardAspect;
  readonly includeEvidence: boolean;
}

interface CardLayout {
  readonly width: number;
  readonly height: number;
  readonly margin: number;
  readonly contentWidth: number;
  readonly titleSize: number;
  readonly bodySize: number;
  readonly smallSize: number;
}

const LAYOUTS: Record<ShareCardAspect, CardLayout> = {
  landscape: {
    width: 1600,
    height: 1000,
    margin: 96,
    contentWidth: 1408,
    titleSize: 58,
    bodySize: 31,
    smallSize: 22,
  },
  square: {
    width: 1200,
    height: 1200,
    margin: 76,
    contentWidth: 1048,
    titleSize: 50,
    bodySize: 29,
    smallSize: 21,
  },
  portrait: {
    width: 1080,
    height: 1920,
    margin: 72,
    contentWidth: 936,
    titleSize: 52,
    bodySize: 30,
    smallSize: 21,
  },
};

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function wrapText(value: string, maxUnits: number): string[] {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const lines: string[] = [];
  let current = '';
  let units = 0;
  for (const character of normalized) {
    const nextUnits = /[\u0000-\u00ff]/.test(character) ? 0.55 : 1;
    if (current && units + nextUnits > maxUnits) {
      if (/[，。！？；：、）】》”’…]/u.test(character)) {
        current += character;
        units += nextUnits;
        continue;
      }
      lines.push(current);
      current = character;
      units = nextUnits;
      continue;
    }
    current += character;
    units += nextUnits;
  }
  if (current) lines.push(current);
  return lines;
}

function unitsForWidth(width: number, fontSize: number): number {
  // wrapText treats a CJK grapheme as one unit and basic Latin as 0.55.
  // Leave a small safety factor for bold glyphs and platform font fallback.
  return Math.max(8, Math.floor(width / (fontSize * 1.08)));
}

function textLines(
  lines: readonly string[],
  input: {
    readonly x: number;
    readonly y: number;
    readonly lineHeight: number;
    readonly className: string;
  },
): string {
  return lines.map((line, index) => (
    `<text class="${input.className}" x="${input.x}" y="${input.y + index * input.lineHeight}">${escapeXml(line)}</text>`
  )).join('');
}

function cardSection(
  input: {
    readonly index: number;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly label: string;
    readonly lines: readonly string[];
    readonly bodySize: number;
    readonly accent?: boolean;
  },
): string {
  const lineHeight = input.bodySize * 1.48;
  const maximumLineCount = Math.max(1, Math.floor((input.height - 114) / lineHeight) + 1);
  const visibleLines = input.lines.slice(0, maximumLineCount);
  return `
      <rect class="${input.accent ? 'section accent' : 'section'}" x="${input.x}" y="${input.y}" width="${input.width}" height="${input.height}" rx="0" />
      <path class="section-rule" d="M${input.x} ${input.y + 8}H${input.x + input.width}" />
      <text class="section-index" x="${input.x + 28}" y="${input.y + 39}">${String(input.index + 1).padStart(2, '0')}</text>
      <text class="section-label" x="${input.x + 72}" y="${input.y + 39}">${escapeXml(input.label)}</text>
      ${textLines(visibleLines, {
        x: input.x + 30,
        y: input.y + 90,
        lineHeight,
        className: 'section-body',
      })}
    `;
}

export function buildShareCardSvg(
  data: ShareCardData,
  options: ShareCardOptions,
): string {
  const layout = LAYOUTS[options.aspect];
  const titleUnits = unitsForWidth(layout.contentWidth, layout.titleSize);
  const taskLine = wrapText(
    data.title,
    unitsForWidth(layout.contentWidth * 0.58, layout.smallSize),
  )[0] ?? data.title;
  const titleLines = wrapText(data.conclusion, titleUnits)
    .slice(0, options.aspect === 'portrait' ? 4 : 3);
  const sectionModels: {
    readonly label: string;
    readonly text: string;
    readonly accent?: boolean;
  }[] = [];
  if (options.includeEvidence && data.evidence) {
    sectionModels.push({
      label: '关键证据 · 由用户选择展示',
      text: `“${data.evidence}”`,
    });
  }
  sectionModels.push({
    label: '唯一焦点',
    text: `${data.focus} · ${data.successCondition}`,
    accent: true,
  });
  if (data.comparison) {
    sectionModels.push({
      label: '初讲 → 复讲 · 同一口径',
      text: `${data.comparison}${data.comparisonDetail ? ` · ${data.comparisonDetail}` : ''}`,
    });
  }

  const sectionGap = options.aspect === 'landscape' ? 22 : 18;
  const sectionTop = layout.margin + 228 + titleLines.length * layout.titleSize * 1.2;
  const sectionBottom = layout.height - layout.margin - 24;
  const sections = sectionModels.map((section, index) => {
    const horizontal = options.aspect === 'landscape';
    const sectionWidth = horizontal
      ? (layout.contentWidth - sectionGap * (sectionModels.length - 1)) / sectionModels.length
      : layout.contentWidth;
    const sectionHeight = horizontal
      ? sectionBottom - sectionTop
      : (sectionBottom - sectionTop - sectionGap * (sectionModels.length - 1)) / sectionModels.length;
    const sectionX = horizontal
      ? layout.margin + index * (sectionWidth + sectionGap)
      : layout.margin;
    const sectionY = horizontal
      ? sectionTop
      : sectionTop + index * (sectionHeight + sectionGap);
    const wrapUnits = unitsForWidth(sectionWidth - 60, layout.bodySize);
    return cardSection({
      index,
      x: sectionX,
      y: sectionY,
      width: sectionWidth,
      height: sectionHeight,
      label: section.label,
      lines: wrapText(section.text, wrapUnits),
      bodySize: layout.bodySize,
      accent: section.accent,
    });
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif; fill: #17221f; }
    .brand { font-family: "Songti SC", STSong, "Noto Serif CJK SC", serif; font-size: 32px; font-weight: 700; letter-spacing: -.3px; }
    .meta { font-size: ${layout.smallSize}px; fill: #587067; }
    .edition, .hero-label, .section-index, .section-label { font-size: ${layout.smallSize}px; font-weight: 730; fill: #23695f; letter-spacing: 1.6px; }
    .edition { font-size: ${layout.smallSize * 0.82}px; fill: #587067; }
    .hero { font-family: "Songti SC", STSong, "Noto Serif CJK SC", serif; font-size: ${layout.titleSize}px; font-weight: 700; letter-spacing: -1.2px; }
    .section { fill: #f8f6ee; stroke: #173d34; stroke-width: 1.5; }
    .section.accent { fill: #dcebe5; stroke: #173d34; }
    .section-rule { fill: none; stroke: #173d34; stroke-width: 3; }
    .section-index { fill: #df6749; }
    .section-body { font-family: "Songti SC", STSong, "Noto Serif CJK SC", serif; font-size: ${layout.bodySize}px; font-weight: 650; }
    .footer { font-size: ${layout.smallSize}px; fill: #587067; }
  </style>
  <rect width="${layout.width}" height="${layout.height}" fill="#f1efe5" />
  <path d="M0 0H${layout.width}" stroke="#173d34" stroke-width="18" />
  <path d="M0 22H${layout.width}" stroke="#65a995" stroke-width="5" />
  <path d="M18 0V${layout.height}" stroke="#df6749" stroke-width="10" />
  <path d="M${layout.width - layout.margin - 112} 18v58h112" fill="none" stroke="#65a995" stroke-width="14" />
  <path d="M${layout.width - layout.margin - 92} 18v38h92" fill="none" stroke="#173d34" stroke-width="9" />
  <g transform="translate(${layout.margin} ${layout.margin})">
    <rect width="54" height="54" rx="2" fill="#f1efe5" stroke="#173d34" stroke-opacity=".42" />
    <path d="M20 46V16h10c9 0 14 5 14 12s-5 12-14 12h-4" fill="none" stroke="#65a995" stroke-linecap="round" stroke-linejoin="round" stroke-width="7" transform="translate(2 2)" />
    <path d="M17 44V14h11c9 0 15 5 15 13s-6 13-15 13h-5" fill="none" stroke="#173d34" stroke-linecap="round" stroke-linejoin="round" stroke-width="6" />
    <circle cx="43" cy="27" r="4" fill="#f1efe5" />
    <circle cx="43" cy="27" r="2.2" fill="#df6749" />
  </g>
  <text class="brand" x="${layout.margin + 72}" y="${layout.margin + 39}">Phrio</text>
  <text class="meta" text-anchor="end" x="${layout.width - layout.margin}" y="${layout.margin + 36}">本地表达练习 · ${escapeXml(data.createdAt)}</text>
  <text class="edition" text-anchor="end" x="${layout.width - layout.margin}" y="${layout.margin + 67}">RESULT PROOF · 01 · LOCAL</text>
  <path d="M${layout.margin} ${layout.margin + 76}H${layout.width - layout.margin}" stroke="#173d34" stroke-width="2" />
  <path d="M${layout.margin} ${layout.margin + 83}H${layout.width - layout.margin}" stroke="#65a995" stroke-width="1" />
  <text class="meta" x="${layout.margin}" y="${layout.margin + 112}">练习 · ${escapeXml(taskLine)}</text>
  <text class="hero-label" x="${layout.margin}" y="${layout.margin + 156}">本轮最先处理</text>
  ${textLines(titleLines, {
    x: layout.margin,
    y: layout.margin + 216,
    lineHeight: layout.titleSize * 1.2,
    className: 'hero',
  })}
  ${sections.join('')}
  <text class="footer" x="${layout.margin}" y="${layout.height - layout.margin + 22}">本卡不含完整逐字稿 · 不生成总分 · 分享内容由用户决定</text>
  <text class="footer" text-anchor="end" x="${layout.width - layout.margin}" y="${layout.height - layout.margin + 22}">Made with Phrio · Local-first</text>
</svg>`;
}

export function buildShareCardMarkdown(
  data: ShareCardData,
  options: ShareCardOptions,
): string {
  const lines = [
    '# Phrio 表达练习结果',
    '',
    '> 本地生成，不包含完整逐字稿，不生成总分。',
    '',
    '## 本轮最先处理',
    '',
    data.conclusion,
  ];
  if (options.includeEvidence && data.evidence) {
    lines.push('', '## 关键证据', '', `> ${data.evidence}`);
  }
  lines.push('', '## 唯一焦点', '', `**${data.focus}**`, '', data.successCondition);
  if (data.comparison) {
    lines.push('', '## 初讲 → 复讲', '', `**${data.comparison}**`);
    if (data.comparisonDetail) lines.push('', data.comparisonDetail);
  }
  lines.push('', '---', '', `Generated locally with Phrio · ${data.createdAt}`);
  return `${lines.join('\n')}\n`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function svgToPng(svg: string, aspect: ShareCardAspect): Promise<Blob> {
  const layout = LAYOUTS[aspect];
  const source = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(source);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('SHARE_CARD_RENDER_FAILED'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = layout.width;
    canvas.height = layout.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('SHARE_CARD_CANVAS_UNAVAILABLE');
    context.drawImage(image, 0, 0, layout.width, layout.height);
    const output = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!output) throw new Error('SHARE_CARD_PNG_FAILED');
    return output;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function exportShareCard(
  data: ShareCardData,
  options: ShareCardOptions,
  format: ShareCardFormat,
): Promise<void> {
  const baseName = `phrio-practice-${new Date().toISOString().slice(0, 10)}`;
  if (format === 'markdown') {
    downloadBlob(
      new Blob([buildShareCardMarkdown(data, options)], { type: 'text/markdown;charset=utf-8' }),
      `${baseName}.md`,
    );
    return;
  }
  const svg = buildShareCardSvg(data, options);
  if (format === 'svg') {
    downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${baseName}.svg`);
    return;
  }
  downloadBlob(await svgToPng(svg, options.aspect), `${baseName}.png`);
}

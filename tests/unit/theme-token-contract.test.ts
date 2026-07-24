// @vitest-environment node

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  new URL('../../src/frontend/styles.css', import.meta.url),
  'utf8',
);

function declarations(selector: string): string {
  const selectorStart = stylesheet.indexOf(selector);
  expect(selectorStart, `missing selector ${selector}`).toBeGreaterThanOrEqual(0);
  const blockStart = stylesheet.indexOf('{', selectorStart);
  const blockEnd = stylesheet.indexOf('}', blockStart);
  return stylesheet.slice(blockStart + 1, blockEnd);
}

function color(block: string, token: string): string {
  const value = block.match(new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  expect(value, `missing color token --${token}`).toBeDefined();
  return value!;
}

function resolvedColor(block: string, fallback: string, token: string): string {
  return block.match(new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})`))?.[1]
    ?? color(fallback, token);
}

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map((value) => {
    const channel = Number.parseInt(value, 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)]
    .sort((left, right) => right - left);
  return (lighter! + 0.05) / (darker! + 0.05);
}

const PALETTES = [
  'fog-blue',
  'smoky-jade',
  'olive',
  'amber',
  'ruby',
  'cocoa',
  'terracotta',
] as const;

describe('appearance semantic token contract', () => {
  it.each(PALETTES)('derives the complete %s light appearance family', (palette) => {
    const block = declarations(`:root[data-light-palette="${palette}"]`);
    for (const token of [
      'surface',
      'underlay',
      'sidebar',
      'hover',
      'hover-strong',
      'selected',
      'selected-hover',
      'accent',
      'accent-strong',
      'accent-deep',
      'action-hover',
      'action-active',
      'focus-ring',
    ]) {
      expect(block).toContain(`--${token}:`);
    }
  });

  it.each(PALETTES)('derives the complete %s dark appearance family', (palette) => {
    const block = declarations(`:root[data-dark-palette="${palette}"]`);
    for (const token of [
      'dark-surface',
      'dark-underlay',
      'dark-sidebar',
      'dark-elevated',
      'dark-hover',
      'dark-hover-strong',
      'dark-selected',
      'dark-selected-hover',
      'dark-accent',
      'dark-accent-strong',
      'dark-accent-deep',
      'dark-action-hover',
      'dark-action-active',
      'dark-focus-ring',
    ]) {
      expect(block).toContain(`--${token}:`);
    }
  });

  it.each([
    ':root[data-theme="dark"]',
    ':root[data-theme="system"],',
  ])('defines complete status and evidence tokens for %s', (selector) => {
    const block = declarations(selector);
    for (const token of [
      'neutral-bg',
      'neutral-text',
      'info-bg',
      'info-text',
      'success-bg',
      'success-text',
      'record',
      'record-bg',
      'record-label',
      'caution-bg',
      'caution-text',
      'danger-bg',
      'danger-text',
      'evidence-redundancy-bg',
      'evidence-redundancy-text',
      'evidence-clarity-bg',
      'evidence-clarity-text',
      'evidence-neutral-bg',
      'evidence-neutral-text',
      'evidence-structure-bg',
      'evidence-structure-text',
    ]) {
      expect(block).toContain(`--${token}:`);
    }
  });

  it('maps every supported text scale to the full interface', () => {
    for (const scale of ['0.9', '1', '1.125', '1.25']) {
      expect(stylesheet).toContain(`data-text-scale="${scale}"`);
    }
    const appShell = declarations('\n.app-shell {');
    expect(appShell).toContain('zoom: var(--text-scale)');
    expect(appShell).toContain('width: 100%');
    expect(appShell).toContain('height: 100%');
  });

  it('keeps text, CTA, and focus contrast readable across light palettes', () => {
    const root = declarations(':root {');
    const lightFamilies = [root, ...PALETTES.map((palette) =>
      declarations(`:root[data-light-palette="${palette}"]`))];

    for (const block of lightFamilies) {
      for (const token of [
        'surface',
        'underlay',
        'sidebar',
        'elevated',
        'field',
        'hover',
        'hover-strong',
        'selected',
        'selected-hover',
      ]) {
        expect(contrast(color(root, 'text-3'), resolvedColor(block, root, token))).toBeGreaterThanOrEqual(4.5);
      }
      const surface = resolvedColor(block, root, 'surface');
      expect(contrast(resolvedColor(block, root, 'accent-strong'), surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(resolvedColor(block, root, 'accent-deep'), '#ffffff')).toBeGreaterThanOrEqual(4.5);
      expect(contrast(resolvedColor(block, root, 'focus-ring'), surface)).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps text, CTA, and focus contrast readable across dark palettes', () => {
    const root = declarations(':root {');
    const darkTheme = declarations(':root[data-theme="dark"]');
    const darkFamilies = [root, ...PALETTES.map((palette) =>
      declarations(`:root[data-dark-palette="${palette}"]`))];

    for (const block of darkFamilies) {
      for (const token of [
        'dark-surface',
        'dark-underlay',
        'dark-sidebar',
        'dark-elevated',
        'dark-hover',
        'dark-hover-strong',
        'dark-selected',
        'dark-selected-hover',
      ]) {
        expect(contrast(color(darkTheme, 'text-3'), resolvedColor(block, root, token))).toBeGreaterThanOrEqual(4.5);
      }
      const surface = resolvedColor(block, root, 'dark-surface');
      expect(contrast(resolvedColor(block, root, 'dark-accent-strong'), surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(resolvedColor(block, root, 'dark-accent-deep'), '#101412')).toBeGreaterThanOrEqual(4.5);
      expect(contrast(resolvedColor(block, root, 'dark-focus-ring'), surface)).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps every status and evidence text token readable on its semantic background', () => {
    const light = declarations(':root {');
    const dark = declarations(':root[data-theme="dark"]');
    const pairs = [
      ['neutral-text', 'neutral-bg'],
      ['info-text', 'info-bg'],
      ['success-text', 'success-bg'],
      ['record-label', 'record-bg'],
      ['caution-text', 'caution-bg'],
      ['danger-text', 'danger-bg'],
      ['evidence-redundancy-text', 'evidence-redundancy-bg'],
      ['evidence-clarity-text', 'evidence-clarity-bg'],
      ['evidence-neutral-text', 'evidence-neutral-bg'],
    ] as const;

    for (const [foreground, background] of pairs) {
      expect(contrast(color(light, foreground), color(light, background))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color(dark, foreground), color(dark, background))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the task-library search focus visible after removing the native input outline', () => {
    const searchInput = declarations('.search-field input {');
    const searchFocus = declarations('.search-field:focus-within {');
    expect(searchInput).toContain('outline: 0');
    expect(searchFocus).toContain('border-color: var(--focus-ring)');
    expect(searchFocus).toContain('box-shadow:');
  });
});

#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_ROOT = path.join(PROJECT_ROOT, 'output', 'playwright', 'electron-visual');
const FIXTURE_SCREENSHOTS = [1, 1.25].flatMap((scale) =>
  [1_440, 1_024].flatMap((width) =>
    ['standard', 'fullscreen'].map(
      (mode) => `electron-dev-fixture-${width}x960-text${scale === 1 ? '100' : '125'}-${mode}.png`,
    ),
  ),
);
const args = new Set(process.argv.slice(2));
const runPackaged = !args.has('--fixture-only');
const runFixture = !args.has('--packaged-only');
const skipPackage = args.has('--skip-package');
const leaveDevBuild = args.has('--leave-dev-build');
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runtime: {
    packaged: null,
    fixture: null,
  },
  scenarios: [],
  motion: null,
  console: {
    packaged: { errors: [], warnings: [] },
    fixture: { errors: [], warnings: [] },
  },
  screenshots: [],
  assertions: [],
  failures: [],
  externalManualChecks: [
    'macOS 麦克风首次允许、拒绝、系统设置恢复后重新授权',
    '真实麦克风输入、设备拔出、睡眠唤醒和长录音停止',
    '安装三份真实 ASR 模型后的 partial/final、端点、尾句和 no-speech 行为',
    '目标 Mac 与真实模型上的 CPU、内存、准确率和延迟',
  ],
};

function recordAssertion(name, passed, details = undefined) {
  report.assertions.push({ name, passed, ...(details === undefined ? {} : { details }) });
  if (!passed) report.failures.push({ name, details });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runCommand(command, commandArgs) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}`));
    });
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a CDP port.');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function captureProcessOutput(child) {
  const lines = [];
  const append = (chunk) => {
    lines.push(...String(chunk).split(/\r?\n/u).filter(Boolean));
    if (lines.length > 500) lines.splice(0, lines.length - 500);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return lines;
}

async function terminateProcessGroup(child) {
  if (!child.pid || child.exitCode !== null) return;
  const waitForExit = new Promise((resolve) => child.once('exit', resolve));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  await Promise.race([waitForExit, delay(5_000)]);
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  await Promise.race([waitForExit, delay(2_000)]);
}

async function waitForCdp(port, child, processLines) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Electron exited before CDP became ready.\n${processLines.slice(-40).join('\n')}`);
    }
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return endpoint;
    } catch {
      // Electron or Forge is still starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Electron CDP at ${endpoint}.\n${processLines.slice(-40).join('\n')}`);
}

async function waitForAppPage(browser) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => /^(?:https?:|phrio-app:)/u.test(candidate.url()));
    if (page) {
      await page.waitForLoadState('domcontentloaded');
      return page;
    }
    await delay(100);
  }
  throw new Error('Electron did not expose an application page through CDP.');
}

function observePage(page, bucket) {
  page.on('console', (message) => {
    if (message.type() === 'error') bucket.errors.push(message.text());
    if (message.type() === 'warning') bucket.warnings.push(message.text());
  });
  page.on('pageerror', (error) => bucket.errors.push(`pageerror: ${error.message}`));
}

async function withElectronProcess({ command, commandArgs, label }, operation) {
  const port = await reservePort();
  const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), `phrio-${label}-`));
  const child = spawn(
    command,
    [...commandArgs, `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDirectory}`],
    {
      cwd: PROJECT_ROOT,
      detached: true,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const processLines = captureProcessOutput(child);
  let browser;
  try {
    const endpoint = await waitForCdp(port, child, processLines);
    browser = await chromium.connectOverCDP(endpoint);
    const page = await waitForAppPage(browser);
    return await operation({ page, processLines, userDataDirectory });
  } finally {
    await browser?.close().catch(() => undefined);
    await terminateProcessGroup(child).catch(() => undefined);
    await writeFile(path.join(OUTPUT_ROOT, `${label}-process.log`), `${processLines.join('\n')}\n`);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

async function setViewport(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(100);
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    devicePixelRatio: window.devicePixelRatio,
  }));
}

async function measureLayout(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const workspace = document.querySelector('.evidence-workspace');
    const appShell = document.querySelector('.app-shell')?.getBoundingClientRect();
    const ledgers = [...document.querySelectorAll('.evidence-ledger')];
    const scrollRegions = workspace
      ? [...workspace.querySelectorAll('*')].filter((element) => {
          const overflowY = getComputedStyle(element).overflowY;
          return overflowY === 'auto' || overflowY === 'scroll';
        })
      : [];
    const rowAlignment = [...document.querySelectorAll('.evidence-row')].map((row) => {
      const source = row.querySelector('.evidence-source-cell')?.getBoundingClientRect();
      const record = row.querySelector('.evidence-record-cell')?.getBoundingClientRect();
      return source && record
        ? {
            segmentId: row.getAttribute('data-segment-row'),
            topDelta: Math.abs(source.top - record.top),
            bottomDelta: Math.abs(source.bottom - record.bottom),
          }
        : null;
    }).filter(Boolean);
    const horizontalOverflow = Math.max(
      0,
      root.scrollWidth - root.clientWidth,
      body.scrollWidth - root.clientWidth,
    );
    return {
      horizontalOverflow,
      appShellCoverage: appShell ? {
        left: appShell.left,
        top: appShell.top,
        right: appShell.right,
        bottom: appShell.bottom,
        rightGap: window.innerWidth - appShell.right,
        bottomGap: window.innerHeight - appShell.bottom,
      } : null,
      root: { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth },
      body: { clientWidth: body.clientWidth, scrollWidth: body.scrollWidth },
      ledgerCount: ledgers.length,
      scrollRegionCount: scrollRegions.length,
      scrollRegionClasses: scrollRegions.map((element) => element.className),
      rowAlignment,
      fullscreen: root.dataset.evidenceFullscreen === 'true',
      textScale: root.dataset.textScale ?? null,
      reduceMotion: root.dataset.reduceMotion ?? null,
    };
  });
}

async function visibleEvidenceAnchor(page) {
  return page.locator('.evidence-ledger').evaluate((ledger) => {
    const top = ledger.getBoundingClientRect().top;
    return [...ledger.querySelectorAll('[data-segment-row]')]
      .find((row) => row.getBoundingClientRect().bottom > top)
      ?.getAttribute('data-segment-row') ?? null;
  });
}

function assertScenario(name, viewport, measurement) {
  recordAssertion(`${name}: viewport`, viewport.innerWidth === Number(name.split('x')[0]) && viewport.innerHeight === 960, viewport);
  recordAssertion(`${name}: horizontal overflow = 0`, measurement.horizontalOverflow === 0, measurement);
  recordAssertion(
    `${name}: app fills the viewport`,
    measurement.appShellCoverage !== null &&
      Math.abs(measurement.appShellCoverage.left) <= 1 &&
      Math.abs(measurement.appShellCoverage.top) <= 1 &&
      Math.abs(measurement.appShellCoverage.rightGap) <= 1 &&
      Math.abs(measurement.appShellCoverage.bottomGap) <= 1,
    measurement.appShellCoverage,
  );
  recordAssertion(`${name}: one evidence ledger`, measurement.ledgerCount === 1, measurement.ledgerCount);
  recordAssertion(
    `${name}: one evidence scroll region`,
    measurement.scrollRegionCount === 1 && measurement.scrollRegionClasses[0]?.includes('evidence-ledger'),
    measurement.scrollRegionClasses,
  );
  recordAssertion(
    `${name}: sentence columns stay aligned`,
    measurement.rowAlignment.every((row) => row.topDelta <= 1 && row.bottomDelta <= 1),
    measurement.rowAlignment,
  );
}

async function seedQaFixture(page) {
  await page.waitForSelector('[data-screen="S04"]');
  await page.getByRole('button', { name: '载入可控 ASR 流' }).click({ force: true });
  await page.waitForFunction(() => document.querySelectorAll('.focus-transcript-line').length === 4);
  await page.getByRole('tab', { name: '证据' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.evidence-row').length === 4);
}

async function setProductAppearance(page, { textScale, reducedMotion }) {
  await page.evaluate(async ({ scale, reduce }) => {
    await window.phrio.updateSettings({ textScale: scale, reducedMotion: reduce });
    window.localStorage.removeItem('phrio.appearance.v1');
  }, { scale: textScale, reduce: reducedMotion });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    ({ scale, reduce }) =>
      document.documentElement.dataset.textScale === String(scale) &&
      document.documentElement.dataset.reduceMotion === String(reduce),
    { scale: textScale, reduce: reducedMotion },
  );
  await seedQaFixture(page);
}

async function captureFixtureScenarios(page, textScale) {
  const textLabel = textScale === 1 ? '100' : '125';
  for (const width of [1_440, 1_024]) {
    if (documentFullscreen(await measureLayout(page))) await page.keyboard.press('Escape');
    const viewport = await setViewport(page, width, 960);
    await page.locator('.evidence-ledger').evaluate((ledger) => { ledger.scrollTop = 0; });
    const standard = await measureLayout(page);
    const standardName = `${width}x960-text${textLabel}-standard`;
    assertScenario(standardName, viewport, standard);
    recordAssertion(`${standardName}: standard state`, !standard.fullscreen, standard.fullscreen);
    const standardPath = path.join(OUTPUT_ROOT, `electron-dev-fixture-${standardName}.png`);
    await page.screenshot({ path: standardPath, scale: 'css' });
    report.screenshots.push({
      path: path.relative(PROJECT_ROOT, standardPath),
      runtime: 'real Electron development window',
      content: 'controlled renderer QA fixture; not real microphone or ASR',
      viewport,
    });
    report.scenarios.push({ name: standardName, viewport, measurement: standard });

    await page.locator('.evidence-ledger').evaluate((ledger) => { ledger.scrollTop = 80; });
    const anchorBefore = await visibleEvidenceAnchor(page);
    await page.getByRole('button', { name: '证据全屏' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.evidenceFullscreen === 'true');
    const anchorFullscreen = await visibleEvidenceAnchor(page);
    const fullscreen = await measureLayout(page);
    const fullscreenName = `${width}x960-text${textLabel}-fullscreen`;
    assertScenario(fullscreenName, viewport, fullscreen);
    recordAssertion(`${fullscreenName}: fullscreen state`, fullscreen.fullscreen, fullscreen.fullscreen);
    recordAssertion(
      `${fullscreenName}: semantic scroll anchor preserved`,
      anchorBefore !== null && anchorBefore === anchorFullscreen,
      { anchorBefore, anchorFullscreen },
    );
    const fullscreenPath = path.join(OUTPUT_ROOT, `electron-dev-fixture-${fullscreenName}.png`);
    await page.screenshot({ path: fullscreenPath, scale: 'css' });
    report.screenshots.push({
      path: path.relative(PROJECT_ROOT, fullscreenPath),
      runtime: 'real Electron development window',
      content: 'controlled renderer QA fixture; not real microphone or ASR',
      viewport,
    });
    report.scenarios.push({ name: fullscreenName, viewport, measurement: fullscreen });

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.documentElement.dataset.evidenceFullscreen === 'false');
    const focus = await page.evaluate(() => ({
      tagName: document.activeElement?.tagName ?? null,
      text: document.activeElement?.textContent?.trim() ?? null,
    }));
    const anchorAfter = await visibleEvidenceAnchor(page);
    recordAssertion(
      `${fullscreenName}: Escape restores focus`,
      focus.tagName === 'BUTTON' && focus.text?.includes('证据全屏'),
      focus,
    );
    recordAssertion(
      `${fullscreenName}: Escape restores semantic scroll anchor`,
      anchorBefore !== null && anchorBefore === anchorAfter,
      { anchorBefore, anchorAfter },
    );
  }
}

function documentFullscreen(measurement) {
  return measurement.fullscreen === true;
}

async function measureMotion(page) {
  return page.evaluate(() => {
    const toMilliseconds = (value) => Math.max(
      0,
      ...value.split(',').map((part) => {
        const token = part.trim();
        if (token.endsWith('ms')) return Number.parseFloat(token);
        if (token.endsWith('s')) return Number.parseFloat(token) * 1_000;
        return 0;
      }),
    );
    return [...document.querySelectorAll('.evidence-row, .evidence-mark, .evidence-record')]
      .map((element) => {
        const style = getComputedStyle(element);
        return {
          className: element.className,
          animationMs: toMilliseconds(style.animationDuration),
          transitionMs: toMilliseconds(style.transitionDuration),
        };
      });
  });
}

async function verifyMotion(page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const systemRows = await measureMotion(page);
  const systemMax = Math.max(0, ...systemRows.flatMap((row) => [row.animationMs, row.transitionMs]));
  recordAssertion('system reduced-motion limits evidence animation to 0.001ms', systemMax <= 0.0011, { systemMax, rows: systemRows });
  recordAssertion(
    'system reduced-motion media query is active',
    await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
  );

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await setProductAppearance(page, { textScale: 1.25, reducedMotion: true });
  const appRows = await measureMotion(page);
  const appMax = Math.max(0, ...appRows.flatMap((row) => [row.animationMs, row.transitionMs]));
  const appDataset = await page.evaluate(() => document.documentElement.dataset.reduceMotion);
  recordAssertion('app reduced-motion persists through real IPC', appDataset === 'true', appDataset);
  recordAssertion('app reduced-motion limits evidence animation to 0.01ms', appMax <= 0.0101, { appMax, rows: appRows });

  const trigger = page.getByRole('button', { name: '证据全屏' });
  await trigger.click();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.textContent?.includes('证据全屏'));
  recordAssertion('fullscreen remains operable with reduced motion', true);
  report.motion = { system: { maximumDurationMs: systemMax }, app: { maximumDurationMs: appMax } };
}

async function runPackagedLane() {
  if (process.platform !== 'darwin') {
    throw new Error('The packaged visual lane currently resolves the macOS Forge output only.');
  }
  const executable = path.join(
    PROJECT_ROOT,
    'out',
    `Phrio-darwin-${process.arch}`,
    'Phrio.app',
    'Contents',
    'MacOS',
    'Phrio',
  );
  await withElectronProcess(
    { command: executable, commandArgs: [], label: 'packaged-real-app' },
    async ({ page }) => {
      observePage(page, report.console.packaged);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-screen="S00"]');
      const viewport = await setViewport(page, 1_440, 960);
      const runtime = await page.evaluate(() => ({
        url: window.location.href,
        protocol: window.location.protocol,
        bridgePresent: typeof window.phrio === 'object',
        rendererHasNodeProcess: typeof window.process !== 'undefined',
        userAgent: navigator.userAgent,
        horizontalOverflow: Math.max(
          0,
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
          document.body.scrollWidth - document.documentElement.clientWidth,
        ),
      }));
      report.runtime.packaged = {
        lane: 'real packaged Electron app with isolated blank userData',
        content: 'real first-run application; no fixture or mocked bridge',
        viewport,
        ...runtime,
      };
      recordAssertion('packaged app uses the secure custom protocol', runtime.protocol === 'phrio-app:', runtime);
      recordAssertion('packaged app exposes the real preload bridge', runtime.bridgePresent, runtime);
      recordAssertion('packaged renderer has no Node process', !runtime.rendererHasNodeProcess, runtime);
      recordAssertion('packaged first-run has horizontal overflow = 0', runtime.horizontalOverflow === 0, runtime);
      const screenshotPath = path.join(OUTPUT_ROOT, 'electron-packaged-real-boot-1440x960.png');
      await page.screenshot({ path: screenshotPath, scale: 'css' });
      report.screenshots.push({
        path: path.relative(PROJECT_ROOT, screenshotPath),
        runtime: 'real packaged Electron application',
        content: 'real blank-userData first-run screen; no QA fixture',
        viewport,
      });
    },
  );
  recordAssertion(
    'packaged renderer console has no errors',
    report.console.packaged.errors.length === 0,
    report.console.packaged,
  );
  recordAssertion(
    'packaged renderer console has no warnings',
    report.console.packaged.warnings.length === 0,
    report.console.packaged,
  );
}

async function runFixtureLane() {
  await withElectronProcess(
    {
      command: 'pnpm',
      commandArgs: ['exec', 'electron-forge', 'start', '--'],
      label: 'dev-electron-fixture',
    },
    async ({ page }) => {
      observePage(page, report.console.fixture);
      await page.evaluate(() => {
        const queryUrl = `${window.location.pathname}?qa=1`;
        window.history.replaceState({}, '', queryUrl);
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-screen="S04"]');
      const runtime = await page.evaluate(() => ({
        url: window.location.href,
        protocol: window.location.protocol,
        bridgePresent: typeof window.phrio === 'object',
        rendererHasNodeProcess: typeof window.process !== 'undefined',
        userAgent: navigator.userAgent,
        qaRoute: new URLSearchParams(window.location.search).has('qa'),
      }));
      report.runtime.fixture = {
        lane: 'real Electron development window and real preload/main process',
        content: 'controlled renderer transcript/evidence input inside a real durable Session',
        proves: ['Electron Chromium layout', 'real IPC settings persistence', 'fullscreen interaction', 'focus', 'motion CSS'],
        doesNotProve: ['real microphone', 'real ASR model', 'cloud provider'],
        ...runtime,
      };
      recordAssertion('fixture lane is a real Electron user agent', /Electron\//u.test(runtime.userAgent), runtime);
      recordAssertion('fixture lane uses the real preload bridge', runtime.bridgePresent, runtime);
      recordAssertion('fixture lane keeps renderer Node disabled', !runtime.rendererHasNodeProcess, runtime);
      recordAssertion('fixture lane is explicitly marked by ?qa=1', runtime.qaRoute, runtime);

      await setProductAppearance(page, { textScale: 1, reducedMotion: false });
      await captureFixtureScenarios(page, 1);
      await setProductAppearance(page, { textScale: 1.25, reducedMotion: false });
      await captureFixtureScenarios(page, 1.25);
      await verifyMotion(page);
    },
  );
  recordAssertion(
    'fixture renderer console has no errors',
    report.console.fixture.errors.length === 0,
    report.console.fixture,
  );
  recordAssertion(
    'all expected fixture screenshots were captured',
    FIXTURE_SCREENSHOTS.every((name) =>
      report.screenshots.some((item) => item.path.endsWith(name))),
    report.screenshots.map((item) => item.path),
  );
}

await rm(OUTPUT_ROOT, { recursive: true, force: true });
await mkdir(OUTPUT_ROOT, { recursive: true });

try {
  if (runFixture) await runFixtureLane();
  // Forge start leaves development URLs in the shared .vite output. Rebuild
  // production after the fixture lane so later packaged smokes cannot consume
  // a stale development main bundle. Do not run this script beside another
  // pnpm start/package process because both intentionally own .vite.
  if ((runPackaged && !skipPackage) || (runFixture && !leaveDevBuild)) {
    await runCommand('pnpm', ['package']);
  }
  if (runPackaged) await runPackagedLane();
} catch (error) {
  report.failures.push({
    name: 'visual verification runtime',
    details: error instanceof Error ? `${error.stack ?? error.message}` : String(error),
  });
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(path.join(OUTPUT_ROOT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

if (report.failures.length > 0) {
  console.error(`Electron visual verification failed with ${report.failures.length} issue(s).`);
  for (const failure of report.failures) console.error(`- ${failure.name}`);
  process.exitCode = 1;
} else {
  console.log(`Electron visual verification passed. Artifacts: ${OUTPUT_ROOT}`);
}

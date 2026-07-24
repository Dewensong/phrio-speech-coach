#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_ROOT = path.join(PROJECT_ROOT, 'output', 'playwright', 'electron-product-tour');
const args = new Set(process.argv.slice(2));
const skipPackage = args.has('--skip-package');
const runProduct = !args.has('--qa-only');
const runQa = !args.has('--product-only');

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scope: {
    runtime: 'real packaged Electron application with isolated blank userData',
    productLane: 'production first-run, product navigation and local IPC behavior',
    qaLane: 'explicit ?qa=1 controlled mic/ASR input through a real durable Session, Fast snapshot, result-first Deep report, optional Drill/retry and explicit paired comparison',
    forbiddenActions: [
      'no microphone request',
      'no API key write or deletion',
      'no bulk training-data deletion; only the isolated Session created by this tour is deleted',
      'no final preference-reset execution',
      'no external AI/network request',
    ],
  },
  runtime: { product: null, qa: null },
  productTour: { steps: [], observations: {} },
  qaTour: { steps: [], observations: {} },
  screenshots: [],
  assertions: [],
  console: {
    product: { errors: [], warnings: [] },
    qa: { errors: [], warnings: [] },
  },
  externalRequests: { product: [], qa: [] },
  failures: [],
  externalManualChecks: [
    'macOS 麦克风首次允许、拒绝、系统设置恢复后重新授权',
    '真实设备上的录音、回放、重录、拔出、睡眠唤醒和长录音停止',
    '安装真实本地 ASR 模型后的 partial/final、VAD、端点、尾句和无语音行为',
    '用户自行配置 OpenAI API Key 后的 live_hint、deep_diagnosis、comparison 真实服务验收',
    '设置页通过 macOS 原生保存面板导出诊断包，以及通过 Finder 打开日志目录',
    '目标 Mac 与真实模型上的 CPU、内存、准确率和端到端延迟',
  ],
};

function recordAssertion(name, passed, details = undefined) {
  report.assertions.push({ name, passed, ...(details === undefined ? {} : { details }) });
  if (!passed) report.failures.push({ name, details });
}

function recordStep(lane, name, details = undefined) {
  report[lane].steps.push({ name, passed: true, ...(details === undefined ? {} : { details }) });
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
      // Electron is still starting.
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

function observePage(page, consoleBucket, requestBucket) {
  page.on('console', (message) => {
    if (message.type() === 'error') consoleBucket.errors.push(message.text());
    if (message.type() === 'warning') consoleBucket.warnings.push(message.text());
  });
  page.on('pageerror', (error) => consoleBucket.errors.push(`pageerror: ${error.message}`));
  page.on('request', (request) => {
    if (/^https?:/u.test(request.url())) {
      const url = new URL(request.url());
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        requestBucket.push({ method: request.method(), url: request.url(), resourceType: request.resourceType() });
      }
    }
  });
}

async function withPackagedElectron(label, operation) {
  if (process.platform !== 'darwin') {
    throw new Error('The packaged product tour currently resolves the macOS Forge output only.');
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
  const port = await reservePort();
  const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), `phrio-${label}-`));
  const child = spawn(
    executable,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDirectory}`],
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
    return await operation({ page, userDataDirectory, processLines });
  } finally {
    await browser?.close().catch(() => undefined);
    await terminateProcessGroup(child).catch(() => undefined);
    await writeFile(path.join(OUTPUT_ROOT, `${label}-process.log`), `${processLines.join('\n')}\n`);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

async function withDevelopmentElectron(label, operation) {
  const port = await reservePort();
  const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), `phrio-${label}-`));
  const child = spawn(
    'pnpm',
    ['exec', 'electron-forge', 'start', '--', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDirectory}`],
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
    return await operation({ page, userDataDirectory, processLines });
  } finally {
    await browser?.close().catch(() => undefined);
    await terminateProcessGroup(child).catch(() => undefined);
    await writeFile(path.join(OUTPUT_ROOT, `${label}-process.log`), `${processLines.join('\n')}\n`);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

async function setViewport(page, width = 1_440, height = 960) {
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

async function waitForScreen(page, screen) {
  await page.locator(`[data-screen="${screen}"]`).waitFor({ state: 'visible' });
  const actual = await page.locator('.app-shell').getAttribute('data-screen');
  recordAssertion(`screen ${screen} is reachable`, actual === screen, { expected: screen, actual });
}

async function captureScreenshot(page, name, lane, content) {
  const outputPath = path.join(OUTPUT_ROOT, `${name}.png`);
  await page.screenshot({ path: outputPath, scale: 'css' });
  report.screenshots.push({
    path: path.relative(PROJECT_ROOT, outputPath),
    lane,
    runtime: lane === 'qa' ? 'real Electron development window' : 'real packaged Electron application',
    content,
    viewport: await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
  });
}

async function movePointerToCanvasBlank(page) {
  const canvas = page.locator('.screen-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Could not resolve the screen canvas for pointer neutralization.');
  await page.mouse.move(
    box.x + Math.max(4, Math.min(box.width - 4, box.width * 0.97)),
    box.y + Math.max(4, Math.min(box.height - 4, box.height * 0.52)),
  );
  await page.waitForTimeout(80);
}

async function sidebarActiveState(page) {
  return page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    items: [...document.querySelectorAll(
      '.sidebar .primary-nav > button, .sidebar .recent-practice-open',
    )].map((element) => ({
      label: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
      active: element.classList.contains('is-active')
        || element.closest('.recent-practice-row')?.classList.contains('is-active') === true,
      ariaCurrent: element.getAttribute('aria-current'),
    })),
  }));
}

async function appRuntime(page) {
  return page.evaluate(() => ({
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
}

async function readDiagnosticEventsOnce(userDataDirectory) {
  const directory = path.join(userDataDirectory, 'diagnostics');
  const readErrors = [];
  let names = [];
  try {
    names = (await readdir(directory))
      .filter((name) => name.startsWith('phrio-diagnostic-') && name.endsWith('.jsonl'))
      .sort();
  } catch (error) {
    if (error?.code !== 'ENOENT') readErrors.push(`directory:${error?.code ?? 'UNKNOWN'}`);
  }
  const events = [];
  const malformedLines = [];
  const fileContents = [];
  for (const name of names) {
    let content;
    try {
      content = await readFile(path.join(directory, name), 'utf8');
    } catch (error) {
      readErrors.push(`${name}:${error?.code ?? 'UNKNOWN'}`);
      continue;
    }
    fileContents.push([name, content]);
    const lines = content.split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        malformedLines.push(`${name}:${index + 1}`);
      }
    }
  }
  return {
    directory,
    names,
    events,
    malformedLines,
    readErrors,
    signature: JSON.stringify([names, fileContents, readErrors]),
  };
}

async function readDiagnosticEvents(userDataDirectory, timeoutMilliseconds = 4_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let attempts = 0;
  let previousHealthySignature = null;
  let latest = await readDiagnosticEventsOnce(userDataDirectory);

  while (true) {
    attempts += 1;
    const healthy = latest.malformedLines.length === 0 && latest.readErrors.length === 0;
    if (healthy && latest.signature === previousHealthySignature) {
      const { signature: _signature, ...snapshot } = latest;
      return { ...snapshot, stable: true, attempts };
    }
    previousHealthySignature = healthy ? latest.signature : null;
    if (Date.now() >= deadline) {
      const { signature: _signature, ...snapshot } = latest;
      return { ...snapshot, stable: false, attempts };
    }
    await delay(125);
    latest = await readDiagnosticEventsOnce(userDataDirectory);
  }
}

const DIAGNOSTIC_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);

function validateDiagnosticEvents(events) {
  const shapeIssues = [];
  const sequenceIssues = [];
  const runSequences = new Map();

  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      shapeIssues.push(`event ${index}: expected an object`);
      continue;
    }
    if (event.schemaVersion !== 'diagnostic-event-1') shapeIssues.push(`event ${index}: schemaVersion`);
    if (typeof event.runId !== 'string' || event.runId.length === 0) shapeIssues.push(`event ${index}: runId`);
    if (!Number.isInteger(event.sequence) || event.sequence < 0) shapeIssues.push(`event ${index}: sequence`);
    if (typeof event.occurredAt !== 'string' || Number.isNaN(Date.parse(event.occurredAt))) {
      shapeIssues.push(`event ${index}: occurredAt`);
    }
    if (!DIAGNOSTIC_LEVELS.has(event.level)) shapeIssues.push(`event ${index}: level`);
    if (typeof event.component !== 'string' || event.component.length === 0) shapeIssues.push(`event ${index}: component`);
    if (typeof event.event !== 'string' || event.event.length === 0) shapeIssues.push(`event ${index}: event`);
    if (!event.fields || typeof event.fields !== 'object' || Array.isArray(event.fields)) {
      shapeIssues.push(`event ${index}: fields`);
    }

    if (typeof event.runId !== 'string' || !Number.isInteger(event.sequence)) continue;
    const run = runSequences.get(event.runId) ?? { previous: null, seen: new Set() };
    if (run.seen.has(event.sequence)) {
      sequenceIssues.push(`run ${event.runId}: duplicate sequence ${event.sequence}`);
    }
    if (run.previous !== null && event.sequence <= run.previous) {
      sequenceIssues.push(`run ${event.runId}: ${event.sequence} followed ${run.previous}`);
    }
    run.seen.add(event.sequence);
    run.previous = event.sequence;
    runSequences.set(event.runId, run);
  }

  return {
    shapeIssues,
    sequenceIssues,
    runIds: [...runSequences.keys()].sort(),
  };
}

async function appearanceSnapshot(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const color = (selector) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element).backgroundColor : null;
    };
    return {
      dataset: {
        theme: root.dataset.theme ?? null,
        lightPalette: root.dataset.lightPalette ?? null,
        darkPalette: root.dataset.darkPalette ?? null,
        textScale: root.dataset.textScale ?? null,
      },
      tokens: {
        surface: style.getPropertyValue('--surface').trim(),
        underlay: style.getPropertyValue('--underlay').trim(),
        sidebar: style.getPropertyValue('--sidebar').trim(),
        elevated: style.getPropertyValue('--elevated').trim(),
        accent: style.getPropertyValue('--accent').trim(),
        selected: style.getPropertyValue('--selected').trim(),
        ink: style.getPropertyValue('--ink').trim(),
      },
      rendered: {
        appShell: color('.app-shell'),
        sidebar: color('.sidebar'),
        workspace: color('.app-workspace'),
        canvas: color('.screen-canvas'),
        commandBar: color('.command-bar'),
      },
    };
  });
}

async function waitForStableAppearance(page, expected) {
  // Theme-bearing shell layers deliberately animate for 160ms. The IPC save
  // acknowledgement can arrive before that paint settles, so visual evidence
  // must wait beyond the transition and then prove the rendered colors match
  // the active semantic tokens instead of sampling an interpolation frame.
  await page.waitForTimeout(220);
  await page.waitForFunction(({ theme, paletteKind, palette }) => {
    const root = document.documentElement;
    if (root.dataset.theme !== theme || root.dataset[paletteKind] !== palette) return false;
    const rootStyle = getComputedStyle(root);
    const normalizeColor = (value) => {
      const probe = document.createElement('span');
      probe.style.color = value;
      probe.style.position = 'fixed';
      probe.style.visibility = 'hidden';
      document.body.append(probe);
      const normalized = getComputedStyle(probe).color;
      probe.remove();
      return normalized;
    };
    const expectedSurface = normalizeColor(rootStyle.getPropertyValue('--surface').trim());
    const expectedSidebar = normalizeColor(rootStyle.getPropertyValue('--sidebar').trim());
    const renderedBackground = (selector) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element).backgroundColor : null;
    };
    return renderedBackground('.app-shell') === expectedSurface
      && renderedBackground('.app-workspace') === expectedSurface
      && renderedBackground('.screen-canvas') === expectedSurface
      && renderedBackground('.sidebar') === expectedSidebar;
  }, expected, { timeout: 5_000 });
}

function renderedLayersChanged(left, right) {
  const keys = ['appShell', 'sidebar', 'workspace', 'canvas', 'commandBar'];
  return keys.filter((key) => left.rendered[key] !== null && left.rendered[key] !== right.rendered[key]);
}

async function clickMode(page, accessibleName) {
  const modeTitle = accessibleName.split(' · ')[0];
  const button = page.locator('.mode-segmented').getByRole('button').filter({ hasText: modeTitle });
  await button.click();
  await button.waitFor({ state: 'visible' });
  const pressed = await button.getAttribute('aria-pressed');
  recordAssertion(`mode switch works: ${accessibleName}`, pressed === 'true', { pressed });
}

async function verifyHomeTextScale(
  page,
  {
    buttonName,
    expectedScale,
    screenshotName,
  },
) {
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  await page.waitForFunction((scale) => document.documentElement.dataset.textScale === scale, expectedScale);
  await page.getByText('已保存到本机', { exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '返回练习', exact: true }).click();
  await waitForScreen(page, 'S01');
  await setViewport(page, 1_024, 960);
  const measurement = await page.evaluate(() => {
    const quickStart = document.querySelector('.free-practice-card .primary-button');
    const quickStartRect = quickStart?.getBoundingClientRect();
    return {
      textScale: document.documentElement.dataset.textScale ?? null,
      quickStartVisible: quickStart instanceof HTMLElement
        && getComputedStyle(quickStart).visibility !== 'hidden'
        && (quickStartRect?.bottom ?? Number.POSITIVE_INFINITY) <= window.innerHeight,
      horizontalOverflow: Math.max(
        0,
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
        document.body.scrollWidth - document.documentElement.clientWidth,
      ),
    };
  });
  recordAssertion(
    `editorial home remains actionable and overflow-free at 1024x960 with ${buttonName}`,
    measurement.textScale === expectedScale
      && measurement.quickStartVisible
      && measurement.horizontalOverflow === 0,
    measurement,
  );
  await captureScreenshot(
    page,
    screenshotName,
    'product',
    `compact editorial home at ${buttonName}`,
  );
  await setViewport(page, 1_440, 960);
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await waitForScreen(page, 'S11');
}

async function runProductTour() {
  await withPackagedElectron('packaged-product-tour', async ({ page, userDataDirectory }) => {
    observePage(page, report.console.product, report.externalRequests.product);
    const viewport = await setViewport(page);
    await waitForScreen(page, 'S00');
    const runtime = await appRuntime(page);
    report.runtime.product = {
      lane: 'production first boot with isolated blank userData',
      viewport,
      ...runtime,
    };
    recordAssertion('product lane uses secure custom protocol', runtime.protocol === 'phrio-app:', runtime);
    recordAssertion('product lane exposes real preload bridge', runtime.bridgePresent, runtime);
    recordAssertion('product lane keeps renderer Node disabled', !runtime.rendererHasNodeProcess, runtime);
    recordAssertion('production first boot has horizontal overflow = 0', runtime.horizontalOverflow === 0, runtime);
    recordAssertion(
      'first-run privacy boundary is visible',
      await page.getByText('录音、本地转写、逐字稿和练习记录').isVisible(),
    );
    await captureScreenshot(page, 'product-01-first-run-1440x960', 'product', 'real blank-userData first-run boundary');
    recordStep('productTour', 'S00 first-run boundary');

    const sessionsBeforeDemo = await page.evaluate(() => window.phrio.listSessions({}));
    await page.getByRole('button', { name: '体验受控演示', exact: true }).click();
    await waitForScreen(page, 'S16');
    recordAssertion(
      'controlled demo declares no microphone, model, record or cloud use',
      await page.getByText('无需授权', { exact: true }).isVisible()
        && await page.getByText(/不请求麦克风、不安装模型/u).isVisible()
        && await page.getByText(/不会调用云端 AI/u).isVisible()
        && await page.locator('.demo-edition-stamp').filter({ hasText: 'FIXTURE EDITION · 01' }).isVisible(),
    );
    await captureScreenshot(page, 'product-01b-demo-evidence-1440x960', 'product', 'controlled demo stage 1 with frozen sentence evidence');
    await page.getByRole('button', { name: /继续演示/u }).click();
    await page.getByRole('heading', { name: '本轮最需要先处理的一件事' }).waitFor();
    await captureScreenshot(page, 'product-01c-demo-focus-1440x960', 'product', 'controlled demo stage 2 with one deterministic focus and Drill');
    await page.getByRole('button', { name: /继续演示/u }).click();
    await page.getByRole('heading', { name: '目标行为更清楚' }).waitFor();
    recordAssertion(
      'controlled demo compares only one criterion and does not generate a total score',
      await page.getByText('不生成总分', { exact: true }).isVisible()
        && await page.getByText(/本轮只比较/u).isVisible()
        && await page.locator('.demo-comparison-stage[data-folio="PAIRED PROOF · 01"]').isVisible()
        && await page.locator('.demo-comparison-grid article[data-folio]').count() === 2,
    );
    await captureScreenshot(page, 'product-01d-demo-comparison-1440x960', 'product', 'controlled demo stage 3 with same-criterion before/after comparison');
    const sessionsAfterDemo = await page.evaluate(() => window.phrio.listSessions({}));
    recordAssertion(
      'controlled demo creates no practice record',
      sessionsAfterDemo.length === sessionsBeforeDemo.length,
      { before: sessionsBeforeDemo.length, after: sessionsAfterDemo.length },
    );
    await setViewport(page, 1_024, 960);
    const compactDemoRuntime = await appRuntime(page);
    recordAssertion(
      'controlled demo has no horizontal overflow at 1024x960',
      compactDemoRuntime.horizontalOverflow === 0,
      compactDemoRuntime,
    );
    await captureScreenshot(page, 'product-01e-demo-comparison-1024x960', 'product', 'compact controlled demo same-criterion comparison');
    await setViewport(page, 1_440, 960);
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await waitForScreen(page, 'S00');
    recordStep('productTour', 'controlled demo completes without permission, persistence or cloud use');

    await page.getByRole('button', { name: '了解并进入练习' }).click();
    await waitForScreen(page, 'S01');
    await page.getByRole('heading', { name: '想到什么，就从这里直接开始说' }).waitFor();
    recordAssertion(
      'free-practice entry is visible and actionable',
      await page.getByRole('button', { name: '直接开始' }).isEnabled(),
    );
    await captureScreenshot(page, 'product-02-home-free-practice-1440x960', 'product', 'S01 with free practice, mode switch and recommendations');
    await setViewport(page, 1_024, 960);
    const compactHome = await page.evaluate(() => ({
      horizontalOverflow: Math.max(
        0,
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
      quickStartVisible: document.querySelector('.free-practice-card .primary-button')
        ?.getBoundingClientRect().bottom ?? null,
      recommendationCount: document.querySelectorAll('.recommendations .task-rows > button').length,
      detailsOpen: document.querySelector('.free-practice-details')?.hasAttribute('open') ?? null,
    }));
    recordAssertion(
      'editorial home stays actionable and overflow-free at 1024x960',
      compactHome.horizontalOverflow === 0
        && compactHome.quickStartVisible !== null
        && compactHome.quickStartVisible <= 960
        && compactHome.recommendationCount === 3
        && compactHome.detailsOpen === false,
      compactHome,
    );
    await captureScreenshot(page, 'product-02b-home-free-practice-1024x960', 'product', 'compact S01 keeps the free-practice action above the fold');
    await page.evaluate(() => {
      document.documentElement.dataset.textScale = '1.25';
    });
    const compactHomeText125 = await page.evaluate(() => ({
      textScale: document.documentElement.dataset.textScale ?? null,
      horizontalOverflow: Math.max(
        0,
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
      quickStartVisible: document.querySelector('.free-practice-card .primary-button')
        ?.getBoundingClientRect().bottom ?? null,
    }));
    recordAssertion(
      'editorial home stays actionable and overflow-free at 1024x960 with 125% text scale',
      compactHomeText125.textScale === '1.25'
        && compactHomeText125.horizontalOverflow === 0
        && compactHomeText125.quickStartVisible !== null
        && compactHomeText125.quickStartVisible <= 960,
      compactHomeText125,
    );
    await captureScreenshot(page, 'product-02c-home-free-practice-1024x960-text125', 'product', 'compact S01 at 125% keeps the primary action available');
    await page.evaluate(() => {
      document.documentElement.dataset.textScale = '1';
    });
    await setViewport(page, 1_440, 960);
    recordStep('productTour', 'onboarding persists and enters S01');

    await clickMode(page, '论证与反驳 · 辩手');
    await clickMode(page, '清晰表达 · 通用');
    await clickMode(page, '决策与对齐 · 产品经理');
    recordStep('productTour', 'all three exercise modes switch inside the exercise composer');

    await page.getByRole('button', { name: '浏览全部' }).click();
    await waitForScreen(page, 'S02');
    await page.getByRole('heading', { name: '挑一个你真的需要说清楚的场景' }).waitFor();
    await clickMode(page, '清晰表达 · 通用');
    const libraryTask = page.locator('.detailed-task-rows > button').first();
    await libraryTask.click();
    const libraryTaskTitle = (await libraryTask.locator('strong').first().textContent())?.trim() ?? '';
    const favoriteButton = page.getByRole('button', { name: '收藏', exact: true });
    await favoriteButton.waitFor({ state: 'visible' });
    await favoriteButton.click();
    await page.getByRole('button', { name: '已收藏', exact: true }).waitFor({ state: 'visible' });
    recordAssertion('task-library selection updates the task inspector', libraryTaskTitle.length > 0, libraryTaskTitle);
    recordAssertion('task favorite is persisted through real IPC', await page.getByRole('button', { name: '已收藏', exact: true }).isVisible());
    await captureScreenshot(page, 'product-03-task-library-favorite-1440x960', 'product', 'task library with selected and favorited task');
    recordStep('productTour', 'task library selection and favorite persistence', { libraryTaskTitle });

    await page.getByRole('button', { name: '收藏题目', exact: true }).click();
    await waitForScreen(page, 'S14');
    recordAssertion('favorite appears in dedicated collection', await page.getByText(libraryTaskTitle, { exact: true }).isVisible(), libraryTaskTitle);
    await captureScreenshot(page, 'product-04-favorites-1440x960', 'product', 'dedicated favorite tasks page');
    recordStep('productTour', 'favorite tasks page');

    await page.getByRole('button', { name: '练习设置', exact: true }).click();
    await waitForScreen(page, 'S15');
    const keepAudio = page.getByRole('radio', { name: /随本次练习保存在本机/u });
    await keepAudio.click();
    await page.getByText('已保存到本机', { exact: true }).waitFor({ state: 'visible' });
    recordAssertion('audio-retention setting persists through real IPC', await keepAudio.isChecked());
    recordStep('productTour', 'practice settings save a real local preference');

    await page.getByRole('button', { name: '外观', exact: true }).click();
    await waitForScreen(page, 'S11');
    await page.getByRole('button', { name: '浅色', exact: true }).click();
    await page.locator('.palette-panel:not(.is-dark)').getByRole('button', { name: '雾蓝', exact: true }).click();
    await page.getByText('已保存到本机', { exact: true }).waitFor({ state: 'visible' });
    await waitForStableAppearance(page, { theme: 'light', paletteKind: 'lightPalette', palette: 'fog-blue' });
    const lightAppearance = await appearanceSnapshot(page);
    recordAssertion(
      'light theme and pale palette apply to root',
      lightAppearance.dataset.theme === 'light' && lightAppearance.dataset.lightPalette === 'fog-blue',
      lightAppearance,
    );
    await captureScreenshot(page, 'product-05-appearance-light-fog-blue-1440x960', 'product', 'full application light theme using pale fog-blue palette');

    await page.getByRole('button', { name: '深色', exact: true }).click();
    await page.getByText('已保存到本机', { exact: true }).waitFor({ state: 'visible' });
    await waitForStableAppearance(page, { theme: 'dark', paletteKind: 'darkPalette', palette: 'flow-teal' });
    const darkAppearance = await appearanceSnapshot(page);
    const changedLayers = renderedLayersChanged(lightAppearance, darkAppearance);
    recordAssertion('dark theme updates the root dataset', darkAppearance.dataset.theme === 'dark', darkAppearance);
    recordAssertion(
      'theme switch changes the whole application shell, not one accent only',
      changedLayers.length >= 4,
      { changedLayers, light: lightAppearance.rendered, dark: darkAppearance.rendered },
    );
    await captureScreenshot(page, 'product-06-appearance-dark-1440x960', 'product', 'full application dark theme');
    await page.getByRole('button', { name: '返回练习', exact: true }).click();
    await waitForScreen(page, 'S01');
    const darkHome = await page.evaluate(() => {
      const quickStart = document.querySelector('.free-practice-card .primary-button');
      return {
        theme: document.documentElement.dataset.theme ?? null,
        quickStartVisible: quickStart instanceof HTMLElement
          && getComputedStyle(quickStart).visibility !== 'hidden',
        horizontalOverflow: Math.max(
          0,
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
          document.body.scrollWidth - document.documentElement.clientWidth,
        ),
      };
    });
    recordAssertion(
      'dark theme remains complete on the editorial home outside settings',
      darkHome.theme === 'dark' && darkHome.quickStartVisible && darkHome.horizontalOverflow === 0,
      darkHome,
    );
    await captureScreenshot(page, 'product-06b-home-dark-1440x960', 'product', 'editorial home in the persisted dark theme');
    await page.getByRole('button', { name: '外观', exact: true }).click();
    await waitForScreen(page, 'S11');
    report.productTour.observations.appearance = { light: lightAppearance, dark: darkAppearance, changedLayers };
    recordStep('productTour', 'full-shell appearance switch and pale light palette');

    await page.getByRole('button', { name: '浅色', exact: true }).click();
    await waitForStableAppearance(page, { theme: 'light', paletteKind: 'lightPalette', palette: 'fog-blue' });
    await page.getByRole('button', { name: '常规与隐私', exact: true }).click();
    await waitForScreen(page, 'S12');
    await page.getByRole('heading', { name: '常规与隐私' }).waitFor();
    await page.getByText(/本地 ASR/u).waitFor();
    await page.getByRole('heading', { name: '本地诊断日志' }).waitFor();
    await page.waitForFunction(() => {
      const environment = document.querySelector('.settings-info-card');
      return environment !== null && !environment.textContent?.includes('检查中…');
    });
    const environmentCopy = await page.locator('.settings-info-card').first().innerText();
    const cloudCopy = await page.locator('.cloud-ai-settings').innerText();
    const saveKeyDisabled = await page.getByRole('button', { name: '保存 Key' }).isDisabled();
    recordAssertion(
      'environment page reports local ASR state without claiming cloud fallback',
      /本地 ASR/u.test(environmentCopy) && /(模型未就绪|模型完整且可读)/u.test(environmentCopy),
      environmentCopy,
    );
    recordAssertion(
      'blank-userData has no configured API key and cannot submit an empty key',
      /API Key\s*未配置/u.test(cloudCopy) && saveKeyDisabled,
      { saveKeyDisabled, cloudCopy },
    );

    const diagnosticFiles = await readDiagnosticEvents(userDataDirectory);
    const diagnosticEventNames = diagnosticFiles.events.map((event) => event.event);
    const diagnosticValidation = validateDiagnosticEvents(diagnosticFiles.events);
    const diagnosticRunIdBeforeClear = diagnosticFiles.events.at(-1)?.runId ?? null;
    const diagnosticMaxSequenceBeforeClear = diagnosticFiles.events
      .filter((event) => event.runId === diagnosticRunIdBeforeClear && Number.isInteger(event.sequence))
      .reduce((maximum, event) => Math.max(maximum, event.sequence), -1);
    const forbiddenDiagnosticFieldNames = new Set([
      'body',
      'text',
      'finaltext',
      'request',
      'response',
      'requestbody',
      'responsebody',
      'requestcontent',
      'responsecontent',
    ]);
    const forbiddenDiagnosticFieldFragments = [
      'audio',
      'pcm',
      'transcript',
      'partial',
      'payload',
      'authorization',
      'apikey',
      'prompt',
      'content',
    ];
    const forbiddenDiagnosticFieldKeys = diagnosticFiles.events.flatMap((event) =>
      Object.keys(event.fields ?? {}).filter((key) => {
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
        return forbiddenDiagnosticFieldNames.has(normalized)
          || forbiddenDiagnosticFieldFragments.some((fragment) => normalized.includes(fragment));
      }),
    );
    recordAssertion(
      'packaged app writes parseable structured diagnostic JSONL',
      diagnosticFiles.names.length > 0
        && diagnosticFiles.events.length > 0
        && diagnosticFiles.stable
        && diagnosticFiles.malformedLines.length === 0,
      {
        fileCount: diagnosticFiles.names.length,
        eventCount: diagnosticFiles.events.length,
        stable: diagnosticFiles.stable,
        pollAttempts: diagnosticFiles.attempts,
        malformedLines: diagnosticFiles.malformedLines,
        readErrors: diagnosticFiles.readErrors,
      },
    );
    recordAssertion(
      'packaged diagnostics satisfy the minimum event schema with monotonic unique per-run sequences',
      diagnosticValidation.shapeIssues.length === 0
        && diagnosticValidation.sequenceIssues.length === 0,
      diagnosticValidation,
    );
    recordAssertion(
      'packaged diagnostics cover app, window, navigation and IPC lifecycle',
      ['app.launch', 'app.ready', 'window.created', 'navigation.screen_changed', 'ipc.invoke-completed']
        .every((name) => diagnosticEventNames.includes(name)),
      { diagnosticEventNames: [...new Set(diagnosticEventNames)].sort() },
    );
    recordAssertion(
      'packaged diagnostics contain no forbidden content-bearing field keys',
      forbiddenDiagnosticFieldKeys.length === 0,
      { forbiddenDiagnosticFieldKeys },
    );
    recordAssertion(
      'general settings presents local capabilities as a numbered device ledger',
      await page.locator('.settings-folio').filter({ hasText: 'DEVICE LEDGER · 01' }).isVisible()
        && await page.locator('.settings-info-card').count() >= 5,
    );
    await captureScreenshot(page, 'product-07a-diagnostics-1440x960', 'product', 'local diagnostic status and support controls');
    await setViewport(page, 1_024, 960);
    const compactDiagnosticRuntime = await appRuntime(page);
    recordAssertion(
      'diagnostic settings has horizontal overflow = 0 at 1024x960',
      compactDiagnosticRuntime.horizontalOverflow === 0,
      compactDiagnosticRuntime,
    );
    await captureScreenshot(page, 'product-07b-diagnostics-1024x960', 'product', 'compact local diagnostic status and support controls');
    await setViewport(page, 1_440, 960);
    report.productTour.observations.diagnostics = {
      fileCount: diagnosticFiles.names.length,
      eventCount: diagnosticFiles.events.length,
      runIdBeforeClear: diagnosticRunIdBeforeClear,
      maxSequenceBeforeClear: diagnosticMaxSequenceBeforeClear,
      uniqueEvents: [...new Set(diagnosticEventNames)].sort(),
      compactHorizontalOverflow: compactDiagnosticRuntime.horizontalOverflow,
    };
    recordStep('productTour', 'structured local diagnostic logging is visible and populated');

    await page.getByRole('button', { name: '清除诊断日志', exact: true }).click();
    await page.getByText(/已清除 \d+ 个诊断日志文件/u).waitFor({ state: 'visible' });
    await page.getByText('0 个 · 0 B', { exact: true }).waitFor({ state: 'visible' });
    const diagnosticFilesAfterClear = await readDiagnosticEvents(userDataDirectory);
    recordAssertion(
      'settings action clears diagnostic JSONL without recreating it during status refresh',
      diagnosticFilesAfterClear.stable
        && diagnosticFilesAfterClear.names.length === 0
        && diagnosticFilesAfterClear.events.length === 0,
      diagnosticFilesAfterClear,
    );
    recordStep('productTour', 'diagnostic logs clear through the real packaged bridge');

    await page.getByRole('button', { name: '清除全部训练数据', exact: true }).click();
    const clearConfirmation = page.getByRole('dialog', { name: '清除全部训练数据？' });
    await clearConfirmation.waitFor({ state: 'visible' });
    recordAssertion('clear-all exposes a second confirmation before deletion', await clearConfirmation.isVisible());
    await captureScreenshot(page, 'product-07-settings-clear-confirmation-1440x960', 'product', 'first destructive confirmation; deletion not executed');
    await clearConfirmation.getByRole('button', { name: '保留训练数据' }).click();
    recordAssertion('clear-all cancellation returns without a success message', !(await page.getByText(/已清除 \d+ 条训练记录/u).isVisible().catch(() => false)));

    await page.getByRole('button', { name: '恢复默认偏好', exact: true }).click();
    const resetConfirmation = page.getByRole('dialog', { name: '恢复默认偏好？' });
    await resetConfirmation.waitFor({ state: 'visible' });
    recordAssertion('preference reset exposes a second confirmation', await resetConfirmation.isVisible());
    await resetConfirmation.getByRole('button', { name: '保留当前偏好' }).click();
    recordAssertion('preference-reset cancellation preserves the selected pale palette', (await appearanceSnapshot(page)).dataset.lightPalette === 'fog-blue');
    recordStep('productTour', 'environment truthfulness and destructive first-stage confirmations');

    await page.getByRole('button', { name: '返回练习' }).click();
    await waitForScreen(page, 'S01');
    await page.getByRole('button', { name: '开始初讲', exact: true }).click();
    await waitForScreen(page, 'S03');
    await page.getByRole('heading', { name: '确认这一次要练什么' }).waitFor();
    recordAssertion(
      'guided practice keeps the editable audience, goal and duration controls on the rehearsal sheet',
      await page.getByRole('textbox', { name: '听众' }).isEditable()
        && await page.getByRole('textbox', { name: '沟通目标' }).isEditable()
        && await page.getByRole('combobox', { name: '目标时长' }).isEnabled(),
    );
    await captureScreenshot(page, 'product-07c-setup-sheet-1440x960', 'product', 'editorial rehearsal sheet before a guided attempt');
    await setViewport(page, 1_024, 960);
    const compactSetup = await page.evaluate(() => ({
      horizontalOverflow: Math.max(
        0,
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
      startButtonBottom: document.querySelector('.setup-inspector .primary-button')
        ?.getBoundingClientRect().bottom ?? null,
    }));
    recordAssertion(
      'rehearsal sheet stays actionable and overflow-free at 1024x960',
      compactSetup.horizontalOverflow === 0
        && compactSetup.startButtonBottom !== null
        && compactSetup.startButtonBottom <= 960,
      compactSetup,
    );
    await captureScreenshot(page, 'product-07d-setup-sheet-1024x960', 'product', 'compact editorial rehearsal sheet');
    await setViewport(page, 1_440, 960);
    await page.getByRole('button', { name: '新练习', exact: true }).click();
    await waitForScreen(page, 'S01');
    const topic = '产品巡检自由练习';
    const freeCard = page.locator('.free-practice-card');
    await freeCard.getByRole('textbox', { name: '自由练习题目' }).fill(topic);
    await freeCard.getByRole('button', { name: '直接开始' }).click();
    await waitForScreen(page, 'S04');
    recordAssertion('free practice creates a real local Session and enters S04', await page.getByText(`${topic} · 初讲`, { exact: false }).isVisible());
    await captureScreenshot(page, 'product-08-free-practice-s04-ready-1440x960', 'product', 'real free-practice Session at S04 before microphone request');
    recordStep('productTour', 'free practice creates a real local Session without requesting microphone');

    await page.getByRole('button', { name: '新练习', exact: true }).click();
    await waitForScreen(page, 'S01');
    const recentRegion = page.getByRole('region', { name: '最近练习' });
    const renamedTopic = '产品巡检 · 自由表达复盘';
    const recordActions = recentRegion.getByRole('button', { name: `管理“${topic}”`, exact: true });
    await recordActions.click();
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    const renameDialog = page.getByRole('dialog', { name: '重命名练习记录' });
    await renameDialog.getByRole('textbox', { name: '记录名称' }).fill(renamedTopic);
    await renameDialog.getByRole('button', { name: '保存名称', exact: true }).click();
    const renamedButton = recentRegion.getByRole('button', { name: renamedTopic, exact: true });
    await renamedButton.waitFor({ state: 'visible' });
    recordAssertion(
      'recent practice rename persists through the real record command',
      await renamedButton.isVisible() && await recentRegion.getByText('清晰表达', { exact: true }).isVisible(),
    );

    await recentRegion.getByRole('button', { name: `管理“${renamedTopic}”`, exact: true }).click();
    await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
    const pinnedActions = recentRegion.getByRole('button', { name: `管理“${renamedTopic}”`, exact: true });
    await pinnedActions.waitFor({ state: 'visible' });
    await pinnedActions.click();
    await page.getByRole('menuitem', { name: '取消置顶', exact: true }).waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.reload();
    await waitForScreen(page, 'S01');
    const reloadedRecentRegion = page.getByRole('region', { name: '最近练习' });
    await reloadedRecentRegion.getByRole('button', { name: renamedTopic, exact: true }).waitFor({ state: 'visible' });
    await reloadedRecentRegion.getByRole('button', { name: `管理“${renamedTopic}”`, exact: true }).click();
    recordAssertion(
      'renamed and pinned recent practice survives an application reload',
      await page.getByRole('menuitem', { name: '取消置顶', exact: true }).isVisible(),
    );
    await page.getByRole('menuitem', { name: '取消置顶', exact: true }).click();
    const unpinnedActions = reloadedRecentRegion.getByRole('button', { name: `管理“${renamedTopic}”`, exact: true });
    await unpinnedActions.waitFor({ state: 'visible' });
    await unpinnedActions.click();
    await page.getByRole('menuitem', { name: '置顶', exact: true }).waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await movePointerToCanvasBlank(page);
    await captureScreenshot(page, 'product-09-recent-record-managed-1440x960', 'product', 'renamed recent practice with a distinct mode tag after persisted pin and unpin');

    const recentButton = reloadedRecentRegion.getByRole('button', { name: renamedTopic, exact: true });
    await recentButton.waitFor({ state: 'visible' });
    await recentButton.click();
    await waitForScreen(page, 'S13');
    const recordHeading = page.getByRole('heading', { name: topic, exact: true });
    await recordHeading.waitFor({ state: 'visible' });
    recordAssertion('a recent-practice row opens its frozen record detail', await recordHeading.isVisible());
    const detailSidebarState = await sidebarActiveState(page);
    const detailActiveItems = detailSidebarState.items.filter((item) => item.active || item.ariaCurrent !== null);
    recordAssertion(
      'S13 standard-width IA activates only the selected recent-practice entry',
      detailSidebarState.viewportWidth === 1_440
        && detailActiveItems.length === 1
        && detailActiveItems[0]?.label === renamedTopic
        && detailActiveItems[0]?.active === true
        && detailActiveItems[0]?.ariaCurrent === 'page',
      detailSidebarState,
    );
    await movePointerToCanvasBlank(page);
    await captureScreenshot(page, 'product-09-recent-record-detail-1440x960', 'product', 'recent practice opens its record detail');

    await page.getByRole('button', { name: '新练习', exact: true }).click();
    await waitForScreen(page, 'S01');
    await page.getByRole('region', { name: '最近练习' }).getByRole('button', { name: '全部', exact: true }).click();
    await waitForScreen(page, 'S10');
    recordAssertion('recent-practice “全部” opens the full history page', await page.getByRole('heading', { name: '回到具体的一次练习' }).isVisible());
    recordAssertion('full history contains the renamed free-practice Session', await page.locator('.history-table').getByText(renamedTopic, { exact: true }).isVisible());
    recordAssertion(
      'full history is a numbered local archive without hiding record management',
      await page.locator('.history-folio').filter({ hasText: 'LOCAL ARCHIVE' }).isVisible()
        && await page.locator('.history-row-number').count() === 1
        && await page.locator('.history-table .practice-record-actions-trigger').isVisible(),
    );
    const historySidebarState = await sidebarActiveState(page);
    const historyActiveItems = historySidebarState.items.filter((item) => item.active || item.ariaCurrent !== null);
    recordAssertion(
      'S10 standard-width IA activates only practice history',
      historySidebarState.viewportWidth === 1_440
        && historyActiveItems.length === 1
        && historyActiveItems[0]?.label === '练习记录'
        && historyActiveItems[0]?.active === true
        && historyActiveItems[0]?.ariaCurrent === 'page',
      historySidebarState,
    );
    await movePointerToCanvasBlank(page);
    await captureScreenshot(page, 'product-10-history-all-1440x960', 'product', 'full history opened from recent-practice “全部”');
    await setViewport(page, 1_024, 960);
    const compactHistory = await page.evaluate(() => {
      const recent = document.querySelector('.sidebar-history');
      const actions = document.querySelector('.history-table .practice-record-actions-trigger');
      return {
        recentSidebarHidden: recent ? getComputedStyle(recent).display === 'none' : true,
        actionsVisible: actions instanceof HTMLElement && actions.getBoundingClientRect().width > 0,
        horizontalOverflow: Math.max(
          0,
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
          document.body.scrollWidth - document.documentElement.clientWidth,
        ),
      };
    });
    recordAssertion(
      'record management remains available in full history at 1024x960 without horizontal overflow',
      compactHistory.recentSidebarHidden
        && compactHistory.actionsVisible
        && compactHistory.horizontalOverflow === 0,
      compactHistory,
    );
    await captureScreenshot(page, 'product-10b-history-actions-1024x960', 'product', 'compact full history keeps record management after the recent sidebar collapses');
    await setViewport(page, 1_440, 960);
    await page.getByRole('button', { name: '外观', exact: true }).click();
    await waitForScreen(page, 'S11');
    await verifyHomeTextScale(page, {
      buttonName: '紧凑 90%',
      expectedScale: '0.9',
      screenshotName: 'product-10c1-home-1024x960-text90',
    });
    await verifyHomeTextScale(page, {
      buttonName: '舒展 112.5%',
      expectedScale: '1.125',
      screenshotName: 'product-10c2-home-1024x960-text1125',
    });
    await page.getByRole('button', { name: '大字 125%', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.textScale === '1.25');
    await page.getByText('已保存到本机', { exact: true }).waitFor({ state: 'visible' });
    recordAssertion(
      'appearance remains a distinct compositor ledger at 125% scale',
      await page.locator('.settings-folio').filter({ hasText: 'COMPOSITOR · 02' }).isVisible(),
    );
    const scaledBackNavigation = page.getByRole('button', { name: '返回练习', exact: true });
    const scaledNavigationState = await scaledBackNavigation.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        display: style.display,
        visibility: style.visibility,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    });
    recordAssertion(
      'settings return navigation remains visible at 125% application scaling',
      scaledNavigationState.display !== 'none'
        && scaledNavigationState.visibility !== 'hidden'
        && scaledNavigationState.rect.right > 0
        && scaledNavigationState.rect.bottom > 0
        && scaledNavigationState.rect.left < scaledNavigationState.viewport.width
        && scaledNavigationState.rect.top < scaledNavigationState.viewport.height,
      scaledNavigationState,
    );
    await captureScreenshot(page, 'product-10c-appearance-1440x960-text125', 'product', '125% application scaling keeps primary navigation visible');
    await scaledBackNavigation.click();
    await waitForScreen(page, 'S01');
    await page.getByRole('button', { name: '练习记录', exact: true }).click();
    await waitForScreen(page, 'S10');
    await setViewport(page, 1_024, 960);
    const scaledHistoryRecord = page.getByRole('listitem').filter({ hasText: renamedTopic });
    const scaledActions = scaledHistoryRecord.getByRole('button', { name: `管理“${renamedTopic}”`, exact: true });
    await scaledActions.focus();
    await scaledActions.press('Enter');
    await page.getByRole('menuitem', { name: '重命名', exact: true }).waitFor({ state: 'visible' });
    const scaledMenu = await page.evaluate(() => {
      const menu = document.querySelector('.practice-record-actions-menu');
      const menuItem = menu?.querySelector('button');
      const menuRect = menu?.getBoundingClientRect();
      const itemRect = menuItem?.getBoundingClientRect();
      return {
        rootScale: document.documentElement.dataset.textScale ?? null,
        menuWidth: menuRect?.width ?? 0,
        itemHeight: itemRect?.height ?? 0,
        insideViewport: Boolean(menuRect)
          && menuRect.left >= 0
          && menuRect.top >= 0
          && menuRect.right <= window.innerWidth
          && menuRect.bottom <= window.innerHeight,
        horizontalOverflow: Math.max(
          0,
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
          document.body.scrollWidth - document.documentElement.clientWidth,
        ),
      };
    });
    recordAssertion(
      'record action menu follows 125% application scaling and stays inside 1024x960',
      scaledMenu.rootScale === '1.25'
        && Math.abs(scaledMenu.menuWidth - 220) <= 2
        && Math.abs(scaledMenu.itemHeight - 45) <= 2
        && scaledMenu.insideViewport
        && scaledMenu.horizontalOverflow === 0,
      scaledMenu,
    );
    await captureScreenshot(page, 'product-10d-history-menu-1024x960-text125', 'product', 'compact full history action menu follows 125% application scaling');
    await page.keyboard.press('Escape');
    await setViewport(page, 1_440, 960);
    await page.getByRole('button', { name: '外观', exact: true }).click();
    await waitForScreen(page, 'S11');
    await page.getByRole('button', { name: '标准 100%', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.textScale === '1');
    await page.getByText('已保存到本机', { exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '返回练习', exact: true }).click();
    await waitForScreen(page, 'S01');
    await page.getByRole('button', { name: '练习记录', exact: true }).click();
    await waitForScreen(page, 'S10');
    const historyRecord = page.getByRole('listitem').filter({ hasText: renamedTopic });
    await historyRecord.getByRole('button', { name: `管理“${renamedTopic}”`, exact: true }).click();
    await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    await page.getByRole('dialog', { name: '删除这次练习？' }).getByRole('button', { name: '保留这次练习', exact: true }).click();
    recordAssertion('recent-practice delete requires confirmation and cancel retains the record', await historyRecord.getByText(renamedTopic, { exact: true }).isVisible());
    await historyRecord.getByRole('button', { name: `管理“${renamedTopic}”`, exact: true }).click();
    await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    await page.getByRole('dialog', { name: '删除这次练习？' }).getByRole('button', { name: '删除记录', exact: true }).click();
    await waitForScreen(page, 'S01');
    recordAssertion(
      'confirmed recent-practice deletion removes the persisted Session from the sidebar',
      await page.getByRole('region', { name: '最近练习' }).getByRole('button', { name: renamedTopic, exact: true }).count() === 0,
    );
    recordStep('productTour', 'recent record rename, pin, unpin, detail, full history and confirmed delete');

    const diagnosticFilesAfterRecovery = await readDiagnosticEvents(userDataDirectory);
    const recoveredDiagnosticValidation = validateDiagnosticEvents(diagnosticFilesAfterRecovery.events);
    const recoveredSameRunEvents = diagnosticFilesAfterRecovery.events.filter(
      (event) => event.runId === diagnosticRunIdBeforeClear,
    );
    const recoveredDiagnosticEventNames = recoveredSameRunEvents.map((event) => event.event);
    const recoveredSequences = recoveredSameRunEvents
      .map((event) => event.sequence)
      .filter((sequence) => Number.isInteger(sequence));
    recordAssertion(
      'diagnostic logger resumes after clear in the same run with later sequence numbers',
      diagnosticFilesAfterRecovery.stable
        && diagnosticFilesAfterRecovery.malformedLines.length === 0
        && diagnosticFilesAfterRecovery.readErrors.length === 0
        && recoveredSameRunEvents.length > 0
        && recoveredSequences.every((sequence) => sequence > diagnosticMaxSequenceBeforeClear)
        && recoveredDiagnosticEventNames.some(
          (eventName) => eventName === 'navigation.screen_changed' || eventName.startsWith('ipc.invoke-'),
        ),
      {
        fileCount: diagnosticFilesAfterRecovery.names.length,
        eventCount: diagnosticFilesAfterRecovery.events.length,
        stable: diagnosticFilesAfterRecovery.stable,
        pollAttempts: diagnosticFilesAfterRecovery.attempts,
        runIdBeforeClear: diagnosticRunIdBeforeClear,
        runIdsAfterClear: recoveredDiagnosticValidation.runIds,
        maxSequenceBeforeClear: diagnosticMaxSequenceBeforeClear,
        recoveredSequences,
        recoveredDiagnosticEventNames: [...new Set(recoveredDiagnosticEventNames)].sort(),
        malformedLines: diagnosticFilesAfterRecovery.malformedLines,
        readErrors: diagnosticFilesAfterRecovery.readErrors,
      },
    );
    recordAssertion(
      'post-clear diagnostics retain the minimum schema and monotonic unique sequence contract',
      recoveredDiagnosticValidation.shapeIssues.length === 0
        && recoveredDiagnosticValidation.sequenceIssues.length === 0,
      recoveredDiagnosticValidation,
    );
    report.productTour.observations.diagnostics.afterClearRecovery = {
      fileCount: diagnosticFilesAfterRecovery.names.length,
      eventCount: diagnosticFilesAfterRecovery.events.length,
      runId: diagnosticRunIdBeforeClear,
      sequences: recoveredSequences,
      uniqueEvents: [...new Set(recoveredDiagnosticEventNames)].sort(),
    };

    const finalRuntime = await appRuntime(page);
    recordAssertion('product tour finishes without horizontal overflow', finalRuntime.horizontalOverflow === 0, finalRuntime);
  });

  recordAssertion('product renderer console has no errors', report.console.product.errors.length === 0, report.console.product);
  recordAssertion('product renderer console has no warnings', report.console.product.warnings.length === 0, report.console.product);
  recordAssertion('product tour makes no external HTTP(S) requests', report.externalRequests.product.length === 0, report.externalRequests.product);
}

async function evidenceMeasurement(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const workspace = document.querySelector('.evidence-workspace');
    const scrollRegions = workspace
      ? [...workspace.querySelectorAll('*')].filter((element) => {
          const overflowY = getComputedStyle(element).overflowY;
          return overflowY === 'auto' || overflowY === 'scroll';
        })
      : [];
    return {
      fullscreen: root.dataset.evidenceFullscreen === 'true',
      segmentIds: [...document.querySelectorAll('[data-segment-row]')]
        .map((row) => row.getAttribute('data-segment-row')),
      annotationIds: [...document.querySelectorAll('[data-evidence-id]')]
        .map((element) => element.getAttribute('data-evidence-id')),
      scrollRegionClasses: scrollRegions.map((element) => element.className),
      horizontalOverflow: Math.max(
        0,
        root.scrollWidth - root.clientWidth,
        document.body.scrollWidth - root.clientWidth,
      ),
      captureState: document.querySelector('.recording-channel')?.getAttribute('data-state') ?? null,
      asrState: document.querySelector('.transcript-channel')?.getAttribute('data-state') ?? null,
      analysisState: document.querySelector('.analysis-channel')?.getAttribute('data-state') ?? null,
      analysisText: document.querySelector('.analysis-channel')?.textContent?.trim() ?? null,
      feedbackVisible: workspace?.getAttribute('data-feedback-visible') ?? null,
    };
  });
}

async function runQaTour() {
  await withDevelopmentElectron('development-qa-tour', async ({ page }) => {
    observePage(page, report.console.qa, report.externalRequests.qa);
    const viewport = await setViewport(page, 1_440, 960);
    await waitForScreen(page, 'S00');
    await page.evaluate(() => {
      window.history.replaceState({}, '', `${window.location.pathname}?qa=1`);
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForScreen(page, 'S04');
    const runtime = await appRuntime(page);
    const qaSession = await page.evaluate(async () => {
      const sessions = await window.phrio.listSessions();
      const session = sessions.find((candidate) => candidate.status === 'first_attempt') ?? null;
      return session ? { id: session.id, status: session.status, taskId: session.taskId } : null;
    });
    if (!qaSession) throw new Error('Controlled QA route did not create a durable first-attempt Session.');
    report.runtime.qa = {
      lane: 'controlled mic/ASR input through a real Electron Session and persistence graph',
      content: 'controlled audio and partial/final events; real IPC, SQLite artifacts, attempt audio, flexible workflow transitions, result card, Drill and explicit paired comparison',
      doesNotProve: ['real microphone device', 'installed ASR model', 'external cloud provider'],
      viewport,
      qaRoute: new URLSearchParams(new URL(runtime.url).search).has('qa'),
      session: qaSession,
      ...runtime,
    };
    recordAssertion('QA lane remains a real Electron runtime', /Electron\//u.test(runtime.userAgent), runtime);
    recordAssertion('QA lane is explicitly marked by ?qa=1', report.runtime.qa.qaRoute, runtime);
    recordAssertion('QA lane creates a durable Session instead of qa-session', qaSession.id !== 'qa-session' && qaSession.status === 'first_attempt', qaSession);

    await page.getByRole('button', { name: '载入可控 ASR 流' }).click({ force: true });
    await page.waitForFunction(() => document.querySelectorAll('.focus-transcript-line').length === 4);
    const focusWorkspace = await page.evaluate(() => ({
      selectedView: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null,
      transcriptLines: document.querySelectorAll('.focus-transcript-line').length,
      evidenceRows: document.querySelectorAll('.evidence-row').length,
      currentGuidance: document.querySelector('[aria-label="当前提示"]')?.textContent?.trim() ?? null,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    }));
    recordAssertion(
      'controlled QA opens in the calm focus view without losing transcript or guidance',
      focusWorkspace.selectedView === '专注'
        && focusWorkspace.transcriptLines === 4
        && focusWorkspace.evidenceRows === 0
        && Boolean(focusWorkspace.currentGuidance)
        && focusWorkspace.horizontalOverflow === 0,
      focusWorkspace,
    );
    await captureScreenshot(page, 'qa-00-s04-focus-1440x960', 'qa', 'controlled final transcript in the default focus workspace');
    const captureDetails = page.locator('details.capture-health-details');
    await captureDetails.getByText('采集详情', { exact: true }).click();
    const expandedCaptureDetails = await page.evaluate(() => ({
      open: document.querySelector('details.capture-health-details')?.hasAttribute('open') === true,
      channels: document.querySelectorAll('.channel-details-grid > div').length,
      captureState: document.querySelector('.recording-channel')?.getAttribute('data-state') ?? null,
      asrState: document.querySelector('.transcript-channel')?.getAttribute('data-state') ?? null,
      analysisState: document.querySelector('.analysis-channel')?.getAttribute('data-state') ?? null,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    }));
    recordAssertion(
      'capture details disclose the same three live channels without page overflow',
      expandedCaptureDetails.open
        && expandedCaptureDetails.channels === 3
        && expandedCaptureDetails.captureState === 'recording'
        && expandedCaptureDetails.asrState === 'segment_finalized'
        && expandedCaptureDetails.analysisState === 'hint_ready'
        && expandedCaptureDetails.horizontalOverflow === 0,
      expandedCaptureDetails,
    );
    await captureScreenshot(page, 'qa-00b-s04-capture-details-1440x960', 'qa', 'expanded recording, transcript and analysis channel details');
    await captureDetails.getByText('采集详情', { exact: true }).click();
    await page.getByRole('tab', { name: '证据' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.evidence-row').length === 4);
    const standard = await evidenceMeasurement(page);
    recordAssertion('controlled QA produces four final shared rows', standard.segmentIds.length === 4, standard);
    recordAssertion('standard S04 has one evidence scroll context', standard.scrollRegionClasses.length === 1 && standard.scrollRegionClasses[0]?.includes('evidence-ledger'), standard);
    recordAssertion('standard S04 has horizontal overflow = 0', standard.horizontalOverflow === 0, standard);
    await captureScreenshot(page, 'qa-01-s04-standard-1440x960', 'qa', 'controlled partial/final/evidence content in standard S04');
    recordStep('qaTour', 'controlled S04 standard evidence workspace');

    const feedbackSettings = page.locator('details.feedback-settings');
    await feedbackSettings.getByText('反馈设置', { exact: true }).click();
    await feedbackSettings.getByRole('checkbox', { name: '显示实时反馈' }).uncheck();
    await page.waitForFunction(() => document.querySelector('.evidence-workspace')?.getAttribute('data-feedback-visible') === 'false');
    recordAssertion('visible feedback control hides feedback without removing transcript rows', (await evidenceMeasurement(page)).segmentIds.length === 4);
    await feedbackSettings.getByRole('checkbox', { name: '显示实时反馈' }).check();
    await page.waitForFunction(() => document.querySelector('.evidence-workspace')?.getAttribute('data-feedback-visible') === 'true');
    recordStep('qaTour', 'feedback disclosure and transcript-preserving visibility toggle');

    await page.getByRole('button', { name: '证据全屏' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.evidenceFullscreen === 'true');
    const fullscreen = await evidenceMeasurement(page);
    recordAssertion('S04 evidence fullscreen is active', fullscreen.fullscreen, fullscreen);
    recordAssertion('fullscreen reuses the same four segment rows', JSON.stringify(fullscreen.segmentIds) === JSON.stringify(standard.segmentIds), { standard, fullscreen });
    recordAssertion('fullscreen keeps one evidence scroll context', fullscreen.scrollRegionClasses.length === 1 && fullscreen.scrollRegionClasses[0]?.includes('evidence-ledger'), fullscreen);
    recordAssertion('fullscreen S04 has horizontal overflow = 0', fullscreen.horizontalOverflow === 0, fullscreen);
    await captureScreenshot(page, 'qa-02-s04-fullscreen-1440x960', 'qa', 'same controlled evidence state in approved fullscreen');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.documentElement.dataset.evidenceFullscreen === 'false');
    const focusText = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
    recordAssertion('Escape exits evidence fullscreen and restores trigger focus', focusText?.includes('证据全屏') === true, focusText);
    recordStep('qaTour', 'S04 fullscreen, shared state and Escape focus restoration');

    await page.getByRole('button', { name: '完成尾句收束' }).click({ force: true });
    await page.waitForFunction(() => document.querySelector('.recording-channel')?.getAttribute('data-state') === 'safe_end');
    await page.getByRole('button', { name: '确认逐字稿' }).waitFor({ state: 'visible' });
    const stopped = await evidenceMeasurement(page);
    const initialPersistence = await page.evaluate(async (sessionId) => {
      const [session, artifacts] = await Promise.all([
        window.phrio.getSession({ sessionId }),
        window.phrio.listArtifacts({ sessionId }),
      ]);
      return {
        status: session?.status ?? null,
        artifactTypes: artifacts.map((artifact) => artifact.type),
        initialSnapshots: artifacts.filter((artifact) => artifact.type === 'attempt_snapshot' && artifact.payload.kind === 'initial').length,
      };
    }, qaSession.id);
    recordAssertion('controlled stop reaches explicit safe_end and ready ASR', stopped.captureState === 'safe_end' && stopped.asrState === 'ready', stopped);
    recordAssertion('tail stop preserves all final rows and evidence', JSON.stringify(stopped.segmentIds) === JSON.stringify(standard.segmentIds), { standard, stopped });
    recordAssertion(
      'initial frozen snapshot is durably persisted before Deep navigation',
      initialPersistence.status === 'first_attempt'
        && initialPersistence.initialSnapshots === 1
        && stopped.analysisText?.includes('Deep Lane 排队') === true,
      { initialPersistence, stopped },
    );
    await captureScreenshot(page, 'qa-03-s04-safe-end-durable-1440x960', 'qa', 'tail safe_end with a real persisted initial Attempt snapshot');

    await page.getByRole('button', { name: '证据全屏' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.evidenceFullscreen === 'true');
    const stoppedFullscreen = await evidenceMeasurement(page);
    recordAssertion('safe_end state is identical in fullscreen', stoppedFullscreen.captureState === 'safe_end' && JSON.stringify(stoppedFullscreen.segmentIds) === JSON.stringify(stopped.segmentIds), { stopped, stoppedFullscreen });
    await captureScreenshot(page, 'qa-04-s04-safe-end-fullscreen-1440x960', 'qa', 'same stopped state and evidence in fullscreen');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.documentElement.dataset.evidenceFullscreen === 'false');
    recordStep('qaTour', 'tail stop, durable snapshot and stopped fullscreen continuity');

    await page.getByRole('button', { name: '确认逐字稿' }).click();
    await waitForScreen(page, 'S05');
    await page.waitForFunction(() => document.querySelectorAll('.transcript-row').length === 4);
    const transcriptReview = await page.evaluate(() => ({
      finalRows: document.querySelectorAll('.transcript-row').length,
      audioVisible: document.querySelector('audio.transcript-audio') !== null,
      editorialFolio: document.querySelector('.transcript-folio')?.textContent?.trim() ?? null,
      correctionActions: document.querySelectorAll('.review-document .transcript-row > button').length,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    }));
    recordAssertion(
      'frozen transcript remains a four-line editable proof sheet with controlled local audio',
      transcriptReview.finalRows === 4
        && transcriptReview.audioVisible
        && transcriptReview.editorialFolio === '稿 01'
        && transcriptReview.correctionActions === 4
        && transcriptReview.horizontalOverflow === 0,
      transcriptReview,
    );
    await captureScreenshot(page, 'qa-05-s05-transcript-review-1440x960', 'qa', 'durable final transcript and locally retained controlled audio');
    await page.getByRole('button', { name: '确认逐字稿，进入复盘' }).click();
    await waitForScreen(page, 'S06');
    await page.getByRole('heading', { name: '可回查、可纠正的原句证据' }).waitFor();

    const focusSelect = page.getByRole('combobox', { name: '选择唯一训练焦点' });
    const focusOptions = await focusSelect.locator('option').allTextContents();
    if (focusOptions.length > 1) await focusSelect.selectOption({ index: 1 });
    const selectedFocus = await focusSelect.locator('option:checked').textContent();
    const diagnosisWorkspace = await page.evaluate(() => ({
      resultCardVisible: document.querySelector('.diagnosis-result-card') !== null,
      finishAnalysisVisible: document.body.textContent?.includes('保存诊断，结束本轮') === true,
      freeRetryVisible: document.body.textContent?.includes('不选焦点，直接复讲') === true,
      drillVisible: document.body.textContent?.includes('选择这个焦点，开始 Drill') === true,
      diagnosisHierarchy: ['一句话结论', '为什么这样判断', '只练一个焦点', '下一步怎么改']
        .every((label) => document.body.textContent?.includes(label)),
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    }));
    recordAssertion('Deep Lane exposes exactly one selected Rubric focus', Boolean(selectedFocus) && await focusSelect.count() === 1, { focusOptions, selectedFocus });
    recordAssertion(
      'Deep Lane presents diagnosis first and exposes three honest next paths',
      diagnosisWorkspace.resultCardVisible
        && diagnosisWorkspace.finishAnalysisVisible
        && diagnosisWorkspace.freeRetryVisible
        && diagnosisWorkspace.drillVisible
        && diagnosisWorkspace.diagnosisHierarchy
        && diagnosisWorkspace.horizontalOverflow === 0,
      diagnosisWorkspace,
    );
    recordAssertion('Deep Lane remains locally usable without cloud configuration', await page.getByText('本地确定性复盘', { exact: true }).isVisible());
    await captureScreenshot(page, 'qa-06-s06-diagnosis-result-1440x960', 'qa', 'polished local diagnosis card with analysis-only, free-retry and structured Drill choices');
    await setViewport(page, 1_024, 960);
    const compactDiagnosisWorkspace = await page.evaluate(() => ({
      resultCardVisible: document.querySelector('.diagnosis-result-card') !== null,
      actionCount: document.querySelectorAll('.deep-path-option').length,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    }));
    recordAssertion(
      'diagnosis-first choices remain usable at 1024x960',
      compactDiagnosisWorkspace.resultCardVisible
        && compactDiagnosisWorkspace.actionCount === 2
        && compactDiagnosisWorkspace.horizontalOverflow === 0,
      compactDiagnosisWorkspace,
    );
    await captureScreenshot(page, 'qa-06b-s06-diagnosis-result-1024x960', 'qa', 'same diagnosis-first choices in the compact desktop layout');
    await setViewport(page, 1_440, 960);
    await page.getByRole('button', { name: '选择这个焦点，开始 Drill' }).click();
    await waitForScreen(page, 'S07');
    await page.getByRole('button', { name: '开始 Drill' }).click();
    await page.getByRole('checkbox', { name: /我已按模板真实口述一遍/ }).check();
    recordAssertion('inline Drill requires an actual start and explicit self-check', await page.getByRole('button', { name: /保存 Drill 并进入复讲/ }).isEnabled());
    const drillSheet = await page.evaluate(() => ({
      folio: document.querySelector('.drill-folio')?.textContent?.trim() ?? null,
      steps: document.querySelectorAll('.drill-steps article').length,
      activeSteps: document.querySelectorAll('.drill-steps article.is-active').length,
      checked: document.querySelector('.drill-self-check input')?.checked === true,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    }));
    recordAssertion(
      'Drill remains one focused rehearsal sheet with start and attestation gates',
      drillSheet.folio === 'REHEARSAL · 01'
        && drillSheet.steps === 3
        && drillSheet.activeSteps === 1
        && drillSheet.checked
        && drillSheet.horizontalOverflow === 0,
      drillSheet,
    );
    await captureScreenshot(page, 'qa-07-s07-drill-1440x960', 'qa', 'single-focus inline Drill after explicit self-check');
    await page.getByRole('button', { name: /保存 Drill 并进入复讲/ }).click();
    await waitForScreen(page, 'S08');

    await page.getByRole('button', { name: '载入可控 ASR 流' }).click({ force: true });
    await page.waitForFunction(() => document.querySelectorAll('.focus-transcript-line').length === 4);
    await page.getByRole('tab', { name: '证据' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.evidence-row').length === 4);
    await page.getByRole('button', { name: '完成尾句收束' }).click({ force: true });
    await page.getByRole('button', { name: /选择下一步/ }).waitFor({ state: 'visible' });
    const retryStopped = await evidenceMeasurement(page);
    const retryPersistence = await page.evaluate(async (sessionId) => {
      const artifacts = await window.phrio.listArtifacts({ sessionId });
      return {
        snapshotKinds: artifacts
          .filter((artifact) => artifact.type === 'attempt_snapshot')
          .map((artifact) => artifact.payload.kind)
          .sort(),
        drillCount: artifacts.filter((artifact) => artifact.type === 'drill_completion').length,
        deepReportCount: artifacts.filter((artifact) => artifact.type === 'deep_report').length,
      };
    }, qaSession.id);
    recordAssertion(
      'retry snapshot, Deep report and Drill completion share the same durable Session',
      JSON.stringify(retryPersistence.snapshotKinds) === JSON.stringify(['initial', 'retry'])
        && retryPersistence.drillCount === 1
        && retryPersistence.deepReportCount >= 1,
      retryPersistence,
    );
    await captureScreenshot(page, 'qa-08-s08-retry-safe-end-1440x960', 'qa', 'same-task retry frozen around the selected focus');
    await page.getByRole('button', { name: /选择下一步/ }).click();
    await waitForScreen(page, 'S09');
    await page.getByRole('heading', { name: '第二遍已经保存，不必强制查看对比' }).waitFor();
    const optionalComparison = await page.evaluate(() => ({
      completionCardVisible: document.querySelector('.retry-completion-card') !== null,
      pairedResultVisible: document.querySelector('.deep-comparison-page') !== null,
      finishWithoutComparisonVisible: document.body.textContent?.includes('保存复讲，结束本轮') === true,
      enterComparisonVisible: document.body.textContent?.includes('查看同一口径对比') === true,
      frozenStamp: document.querySelector('.retry-completion-stamp')?.textContent?.trim() ?? null,
      activeStage: document.querySelector('.stage-rail li.is-active')?.textContent?.trim() ?? null,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    }));
    recordAssertion(
      'retry completion waits for an explicit comparison choice',
      optionalComparison.completionCardVisible
        && !optionalComparison.pairedResultVisible
        && optionalComparison.finishWithoutComparisonVisible
        && optionalComparison.enterComparisonVisible
        && optionalComparison.frozenStamp === 'TAKE 02 · FROZEN'
        && optionalComparison.activeStage?.includes('复讲')
        && optionalComparison.horizontalOverflow === 0,
      optionalComparison,
    );
    await captureScreenshot(page, 'qa-09-s09-optional-comparison-1440x960', 'qa', 'retry saved with explicit finish-or-compare choice');
    await setViewport(page, 1_024, 960);
    const compactOptionalComparison = await page.evaluate(() => ({
      completionCardVisible: document.querySelector('.retry-completion-card') !== null,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    }));
    recordAssertion(
      'optional comparison decision remains usable at 1024x960',
      compactOptionalComparison.completionCardVisible
        && compactOptionalComparison.horizontalOverflow === 0,
      compactOptionalComparison,
    );
    await captureScreenshot(page, 'qa-09b-s09-optional-comparison-1024x960', 'qa', 'same explicit finish-or-compare decision in the compact desktop layout');
    await setViewport(page, 1_440, 960);
    await page.getByRole('button', { name: '查看同一口径对比' }).click();
    await page.locator('.deep-comparison-page > header h1').waitFor();
    const comparison = await page.evaluate(() => ({
      heading: document.querySelector('.deep-comparison-page > header h1')?.textContent?.trim() ?? null,
      transcriptColumns: document.querySelectorAll('.comparison-evidence-pair > article').length,
      transcriptLines: document.querySelectorAll('.comparison-full-transcript > div').length,
      protocolVisible: document.body.textContent?.includes('paired-1 · 不生成总分') === true,
      activeStage: document.querySelector('.stage-rail li.is-active')?.textContent?.trim() ?? null,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    }));
    recordAssertion('paired comparison uses two full proof folios, the frozen focus and no score', comparison.transcriptColumns === 2 && comparison.transcriptLines === 8 && comparison.protocolVisible && comparison.activeStage?.includes('对比') && comparison.horizontalOverflow === 0, comparison);
    await captureScreenshot(page, 'qa-10-s09-paired-comparison-1440x960', 'qa', 'paired-1 initial/retry comparison after explicit entry');

    await page.getByRole('button', { name: '保存本轮练习' }).click();
    await waitForScreen(page, 'S10');
    await page.getByRole('heading', { name: '回到具体的一次练习' }).waitFor();
    const completedGraph = await page.evaluate(async (sessionId) => {
      const [session, artifacts] = await Promise.all([
        window.phrio.getSession({ sessionId }),
        window.phrio.listArtifacts({ sessionId }),
      ]);
      return {
        status: session?.status ?? null,
        attemptKinds: session?.attempts.map((attempt) => attempt.kind).sort() ?? [],
        attemptStatuses: session?.attempts.map((attempt) => attempt.status).sort() ?? [],
        snapshotCount: artifacts.filter((artifact) => artifact.type === 'attempt_snapshot').length,
        comparisonCount: artifacts.filter((artifact) => artifact.type === 'attempt_comparison').length,
        transcriptEvidenceRetained: artifacts
          .filter((artifact) => artifact.type === 'attempt_snapshot')
          .every((artifact) => artifact.payload.finalSegments.length === 4 && artifact.payload.annotations.length > 0),
      };
    }, qaSession.id);
    recordAssertion(
      'completed graph retains two confirmed Attempts, two snapshots, evidence and one comparison',
      completedGraph.status === 'completed'
        && JSON.stringify(completedGraph.attemptKinds) === JSON.stringify(['initial', 'retry'])
        && completedGraph.attemptStatuses.every((status) => status === 'confirmed')
        && completedGraph.snapshotCount === 2
        && completedGraph.comparisonCount === 1
        && completedGraph.transcriptEvidenceRetained,
      completedGraph,
    );
    const completedRow = page.locator('.history-table .history-row-open').filter({
      hasText: '我觉得就是我们可能需要先把这件事的边界说清楚。',
    }).first();
    await completedRow.waitFor();
    recordAssertion(
      'completed practice defaults its record name to the first frozen final sentence',
      await completedRow.isVisible(),
    );
    await captureScreenshot(page, 'qa-11-s10-completed-history-1440x960', 'qa', 'completed durable practice visible in full history');
    await completedRow.click();
    await waitForScreen(page, 'S13');
    await page.locator('.record-detail-page').waitFor();
    const historyDetail = await page.evaluate(() => ({
      attemptCards: document.querySelectorAll('.record-attempts > *').length,
      snapshotSections: document.querySelectorAll('.attempt-record').length,
      hasComparison: document.querySelector('.record-comparison-card') !== null,
      hasFocus: document.querySelector('.diagnosis-focus-plan') !== null,
      hasFrozenTranscript: document.body.textContent?.includes('冻结逐字稿') === true,
      dossierFolio: document.querySelector('.record-dossier-folio')?.textContent?.trim() ?? null,
      detailTabs: document.querySelectorAll('.record-detail-view-tabs [role="tab"]').length,
      diagnosisHierarchy: ['一句话结论', '为什么这样判断', '只练一个焦点', '下一步怎么改']
        .every((label) => document.body.textContent?.includes(label)),
    }));
    recordAssertion(
      'completed history defaults to a clear diagnosis hierarchy while keeping both formats accessible',
      historyDetail.attemptCards === 2
        && historyDetail.hasComparison
        && historyDetail.hasFocus
        && historyDetail.hasFrozenTranscript
        && historyDetail.dossierFolio === 'SESSION FILE · LOCAL'
        && historyDetail.detailTabs === 2
        && historyDetail.diagnosisHierarchy,
      historyDetail,
    );
    await captureScreenshot(page, 'qa-12-s13-diagnosis-result-1440x960', 'qa', 'completed record defaults to the conclusion, evidence basis, one focus and next step hierarchy');

    await page.getByRole('button', { name: '展示与分享', exact: true }).click();
    const shareDialog = page.getByRole('dialog', { name: '展示与分享练习结果' });
    await shareDialog.waitFor({ state: 'visible' });
    const evidenceToggle = shareDialog.getByRole('checkbox', { name: /加入关键证据原句/u });
    const shareDefaults = {
      evidenceIncluded: await evidenceToggle.isChecked(),
      aspectOptions: await shareDialog.locator('.share-aspect-options > button').count(),
      exportOptions: await shareDialog.locator('.share-export-actions > button').count(),
      privacyCopyVisible: await shareDialog.getByText(/不会创建公开链接/u).isVisible(),
    };
    recordAssertion(
      'share card defaults to evidence redaction and exposes local formats',
      !shareDefaults.evidenceIncluded
        && shareDefaults.aspectOptions === 3
        && shareDefaults.exportOptions === 3
        && shareDefaults.privacyCopyVisible,
      shareDefaults,
    );
    await captureScreenshot(page, 'qa-12b-share-card-controls-1440x960', 'qa', 'local result-card preview with evidence opt-in disabled by default');
    await setViewport(page, 1_024, 960);
    const compactShareRuntime = await appRuntime(page);
    recordAssertion(
      'share-card workspace has no horizontal overflow at 1024x960',
      compactShareRuntime.horizontalOverflow === 0,
      compactShareRuntime,
    );
    await captureScreenshot(page, 'qa-12bb-share-card-controls-1024x960', 'qa', 'compact local result-card preview and export controls');
    await setViewport(page, 1_440, 960);

    const svgDownloadPromise = page.waitForEvent('download');
    await shareDialog.getByRole('button', { name: /导出 SVG/u }).click();
    const svgDownload = await svgDownloadPromise;
    const svgDownloadStream = await svgDownload.createReadStream();
    let exportedSvg = '';
    for await (const chunk of svgDownloadStream) exportedSvg += chunk.toString();
    recordAssertion(
      'default SVG export omits the frozen evidence quote and complete transcript',
      svgDownload.suggestedFilename().endsWith('.svg')
        && !exportedSvg.includes('我觉得就是我们可能需要先把这件事的边界说清楚。')
        && !exportedSvg.includes('冻结逐字稿')
        && exportedSvg.includes('不含完整逐字稿')
        && exportedSvg.includes('RESULT PROOF · 01 · LOCAL')
        && exportedSvg.includes('rx="0"')
        && !exportedSvg.includes('rx="24"'),
      { filename: svgDownload.suggestedFilename(), byteLength: Buffer.byteLength(exportedSvg) },
    );

    await shareDialog.getByRole('button', { name: /纯净展示模式/u }).click();
    await page.locator('.share-result-dialog.is-clean-presentation').waitFor({ state: 'visible' });
    recordAssertion(
      'clean presentation hides sharing controls while keeping the card visible',
      !(await shareDialog.locator('.share-card-controls').isVisible())
        && await shareDialog.getByAltText('Phrio 练习结果分享卡预览').isVisible(),
    );
    await captureScreenshot(page, 'qa-12c-share-card-presentation-1440x960', 'qa', 'privacy-safe clean presentation mode');
    await page.keyboard.press('Escape');
    await shareDialog.locator('.share-card-controls').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await shareDialog.waitFor({ state: 'hidden' });
    recordStep('qaTour', 'privacy-safe local result card, SVG export and clean presentation');

    const locateFrozenEvidence = page.getByRole('button', { name: /定位冻结原句/ });
    await locateFrozenEvidence.focus();
    await locateFrozenEvidence.press('Enter');
    await page.getByRole('heading', { name: '原句与问题逐句对齐' }).waitFor();
    const evidenceLocationFocus = await page.evaluate(() => {
      const focused = document.activeElement;
      const activeRecord = document.querySelector('.frozen-evidence-ledger .evidence-record.is-active');
      return {
        focusedClass: focused?.className ?? null,
        focusedEvidenceId: focused?.getAttribute('data-evidence-id') ?? null,
        activeEvidenceId: activeRecord?.getAttribute('data-evidence-id') ?? null,
      };
    });
    recordAssertion(
      'diagnosis evidence link moves keyboard focus into the matching frozen O record',
      typeof evidenceLocationFocus.focusedClass === 'string'
        && evidenceLocationFocus.focusedClass.includes('evidence-record')
        && evidenceLocationFocus.focusedEvidenceId !== null
        && evidenceLocationFocus.focusedEvidenceId === evidenceLocationFocus.activeEvidenceId,
      evidenceLocationFocus,
    );
    const frozenEvidence1440 = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.frozen-evidence-ledger .evidence-row')];
      const rowAlignment = rows.map((row) => {
        const source = row.querySelector('.evidence-source-cell')?.getBoundingClientRect();
        const record = row.querySelector('.evidence-record-cell')?.getBoundingClientRect();
        return {
          topDelta: source && record ? Math.abs(source.top - record.top) : null,
          bottomDelta: source && record ? Math.abs(source.bottom - record.bottom) : null,
        };
      });
      const scrollContainers = [...document.querySelectorAll('.record-detail-page *')].filter((element) => {
        const style = getComputedStyle(element);
        return /(auto|scroll)/u.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
      });
      return {
        viewportWidth: window.innerWidth,
        rows: rows.length,
        columns: document.querySelectorAll('.frozen-evidence-ledger .evidence-column-head > span').length,
        attemptTabs: document.querySelectorAll('.record-attempt-tabs [role="tab"]').length,
        selectedAttempt: document.querySelector('.record-attempt-tabs [aria-selected="true"]')?.textContent?.trim() ?? null,
        partialRows: document.querySelectorAll('.frozen-evidence-ledger .is-partial').length,
        scrollContainers: scrollContainers.map((element) => element.className),
        rowAlignment,
        horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      };
    });
    recordAssertion(
      'S13 frozen initial evidence reuses the two-column shared rows with one scroll context',
      frozenEvidence1440.viewportWidth === 1_440
        && frozenEvidence1440.rows === 4
        && frozenEvidence1440.columns === 2
        && frozenEvidence1440.attemptTabs === 2
        && frozenEvidence1440.selectedAttempt?.includes('初讲')
        && frozenEvidence1440.partialRows === 0
        && frozenEvidence1440.scrollContainers.length === 1
        && frozenEvidence1440.rowAlignment.every((row) => row.topDelta !== null && row.topDelta <= 2 && row.bottomDelta !== null && row.bottomDelta <= 2)
        && frozenEvidence1440.horizontalOverflow === 0,
      frozenEvidence1440,
    );
    await captureScreenshot(page, 'qa-13-s13-frozen-evidence-1440x960', 'qa', 'historical initial Attempt in the approved real-time evidence format');

    await page.getByRole('tab', { name: /复讲/ }).click();
    const retryEvidence = await page.evaluate(() => ({
      selectedAttempt: document.querySelector('.record-attempt-tabs [aria-selected="true"]')?.textContent?.trim() ?? null,
      sentenceMeta: document.querySelector('.frozen-evidence-ledger .segment-meta')?.textContent?.trim() ?? null,
      rows: document.querySelectorAll('.frozen-evidence-ledger .evidence-row').length,
    }));
    recordAssertion(
      'history switches to the retry snapshot without relabeling it as the initial Attempt',
      retryEvidence.selectedAttempt?.includes('复讲')
        && retryEvidence.sentenceMeta?.includes('A2:S01.1')
        && retryEvidence.rows === 4,
      retryEvidence,
    );

    await setViewport(page, 1_024, 960);
    const frozenEvidence1024 = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      columns: document.querySelectorAll('.frozen-evidence-ledger .evidence-column-head > span').length,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      pageOverflowX: document.querySelector('.record-detail-page')
        ? Math.max(0, document.querySelector('.record-detail-page').scrollWidth - document.querySelector('.record-detail-page').clientWidth)
        : null,
    }));
    recordAssertion(
      'S13 frozen evidence remains two-column at 1024x960 with zero horizontal overflow',
      frozenEvidence1024.viewportWidth === 1_024
        && frozenEvidence1024.columns === 2
        && frozenEvidence1024.horizontalOverflow === 0
        && frozenEvidence1024.pageOverflowX === 0,
      frozenEvidence1024,
    );
    await captureScreenshot(page, 'qa-14-s13-frozen-evidence-1024x960', 'qa', 'historical retry Attempt remains readable in two columns at compact width');

    await page.evaluate(() => {
      document.documentElement.dataset.textScale = '1.25';
    });
    await page.waitForTimeout(120);
    const frozenEvidence1024Text125 = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.frozen-evidence-ledger .evidence-row')];
      return {
        textScale: document.documentElement.dataset.textScale ?? null,
        columns: document.querySelectorAll('.frozen-evidence-ledger .evidence-column-head > span').length,
        rowAlignment: rows.map((row) => {
          const source = row.querySelector('.evidence-source-cell')?.getBoundingClientRect();
          const record = row.querySelector('.evidence-record-cell')?.getBoundingClientRect();
          return {
            topDelta: source && record ? Math.abs(source.top - record.top) : null,
            bottomDelta: source && record ? Math.abs(source.bottom - record.bottom) : null,
          };
        }),
        horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      };
    });
    recordAssertion(
      'S13 frozen evidence remains aligned and overflow-free at 1024x960 with 125% text scale',
      frozenEvidence1024Text125.textScale === '1.25'
        && frozenEvidence1024Text125.columns === 2
        && frozenEvidence1024Text125.rowAlignment.every((row) => (
          row.topDelta !== null && row.topDelta <= 2 && row.bottomDelta !== null && row.bottomDelta <= 2
        ))
        && frozenEvidence1024Text125.horizontalOverflow === 0,
      frozenEvidence1024Text125,
    );
    await captureScreenshot(page, 'qa-14b-s13-frozen-evidence-1024x960-text125', 'qa', 'historical retry Attempt remains two-column and aligned at 125% text scale');
    await page.evaluate(() => {
      document.documentElement.dataset.textScale = '1';
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell').waitFor({ state: 'visible' });
    const screenAfterReload = await page.locator('.app-shell').getAttribute('data-screen');
    if (screenAfterReload !== 'S10') {
      await page.getByRole('button', { name: '练习记录', exact: true }).click();
      await waitForScreen(page, 'S10');
    }
    const reloadedCompletedRow = page.locator('.history-table .history-row-open').filter({
      hasText: '我觉得就是我们可能需要先把这件事的边界说清楚。',
    }).first();
    await reloadedCompletedRow.click();
    await waitForScreen(page, 'S13');
    await page.getByRole('tab', { name: /实时证据/ }).click();
    await page.getByRole('heading', { name: '原句与问题逐句对齐' }).waitFor();
    const reloadedEvidence = await page.evaluate(() => ({
      rows: document.querySelectorAll('.frozen-evidence-ledger .evidence-row').length,
      annotations: document.querySelectorAll('.frozen-evidence-ledger .evidence-record').length,
      initialSelected: document.querySelector('.record-attempt-tabs [aria-selected="true"]')?.textContent?.includes('初讲') === true,
    }));
    recordAssertion(
      'reload keeps the frozen transcript and O evidence available in the record detail',
      reloadedEvidence.rows === 4 && reloadedEvidence.annotations > 0 && reloadedEvidence.initialSelected,
      reloadedEvidence,
    );

    report.qaTour.observations = {
      standard,
      fullscreen,
      stopped,
      stoppedFullscreen,
      transcriptReview,
      selectedFocus,
      retryStopped,
      retryPersistence,
      comparison,
      completedGraph,
      historyDetail,
      frozenEvidence1440,
      retryEvidence,
      frozenEvidence1024,
      frozenEvidence1024Text125,
      reloadedEvidence,
    };
    recordStep('qaTour', 'durable Fast snapshot → Deep result → retry → comparison → history diagnosis and frozen evidence views');
  });

  recordAssertion('QA renderer console has no errors', report.console.qa.errors.length === 0, report.console.qa);
  const unexpectedWarnings = report.console.qa.warnings.filter(
    (warning) => !warning.includes('Electron Security Warning (Insecure Content-Security-Policy)'),
  );
  recordAssertion(
    'QA renderer has no unexpected warnings beyond Electron development CSP notice',
    unexpectedWarnings.length === 0,
    { unexpectedWarnings, developmentOnlyWarnings: report.console.qa.warnings },
  );
  recordAssertion('QA tour makes no external HTTP(S) requests', report.externalRequests.qa.length === 0, report.externalRequests.qa);
}

await rm(OUTPUT_ROOT, { recursive: true, force: true });
await mkdir(OUTPUT_ROOT, { recursive: true });

try {
  if (runQa) await runQaTour();
  // Forge start owns the shared .vite output. Rebuild production after the QA
  // lane so a later packaged smoke cannot consume development entry points.
  if (!skipPackage) await runCommand('pnpm', ['package']);
  if (runProduct) await runProductTour();
} catch (error) {
  report.failures.push({
    name: 'Electron product-tour runtime',
    details: error instanceof Error ? `${error.stack ?? error.message}` : String(error),
  });
} finally {
  report.completedAt = new Date().toISOString();
  report.summary = {
    assertionCount: report.assertions.length,
    passedAssertionCount: report.assertions.filter((assertion) => assertion.passed).length,
    failedAssertionCount: report.assertions.filter((assertion) => !assertion.passed).length,
    screenshotCount: report.screenshots.length,
    productStepCount: report.productTour.steps.length,
    qaStepCount: report.qaTour.steps.length,
  };
  await writeFile(path.join(OUTPUT_ROOT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}

if (report.failures.length > 0) {
  console.error(`Electron product tour failed with ${report.failures.length} issue(s).`);
  for (const failure of report.failures) console.error(`- ${failure.name}`);
  process.exitCode = 1;
} else {
  console.log(`Electron product tour passed. Artifacts: ${OUTPUT_ROOT}`);
}

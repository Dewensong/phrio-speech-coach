#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_ROOT = path.join(PROJECT_ROOT, 'output', 'propagation-assets');
const ASSET_ROOT = path.join(PROJECT_ROOT, 'docs', 'assets');
const skipPackage = process.argv.includes('--skip-package');

await rm(OUTPUT_ROOT, { recursive: true, force: true });
await mkdir(OUTPUT_ROOT, { recursive: true });
await mkdir(ASSET_ROOT, { recursive: true });

if (!skipPackage) await runCommand('pnpm', ['package'], { inherit: true });

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
const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'phrio-propagation-'));
const processLog = [];
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
captureOutput(child.stdout, processLog);
captureOutput(child.stderr, processLog);

let browser;
const externalRequests = [];
const consoleErrors = [];
const framePaths = [
  path.join(OUTPUT_ROOT, 'demo-01-evidence.png'),
  path.join(OUTPUT_ROOT, 'demo-02-focus.png'),
  path.join(OUTPUT_ROOT, 'demo-03-comparison.png'),
];

try {
  const endpoint = await waitForCdp(port, child, processLog);
  browser = await chromium.connectOverCDP(endpoint);
  const page = await waitForAppPage(browser);
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('request', (request) => {
    if (!/^https?:/u.test(request.url())) return;
    const url = new URL(request.url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      externalRequests.push({ method: request.method(), url: request.url() });
    }
  });

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('[data-screen="S00"]').waitFor({ state: 'visible' });
  const sessionsBefore = await page.evaluate(() => window.phrio.listSessions({}));
  await page.getByRole('button', { name: '体验受控演示', exact: true }).click();
  await page.locator('[data-screen="S16"]').waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: framePaths[0], scale: 'css' });

  await page.getByRole('button', { name: /继续演示/u }).click();
  await page.getByRole('heading', { name: '本轮最需要先处理的一件事' }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: framePaths[1], scale: 'css' });

  await page.getByRole('button', { name: /继续演示/u }).click();
  await page.getByRole('heading', { name: '目标行为更清楚' }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: framePaths[2], scale: 'css' });
  const sessionsAfter = await page.evaluate(() => window.phrio.listSessions({}));

  if (sessionsAfter.length !== sessionsBefore.length) {
    throw new Error('The controlled demo created a practice record while capturing assets.');
  }
  if (externalRequests.length > 0) {
    throw new Error(`The controlled demo made external requests: ${JSON.stringify(externalRequests)}`);
  }
  if (consoleErrors.length > 0) {
    throw new Error(`The controlled demo emitted renderer errors: ${JSON.stringify(consoleErrors)}`);
  }

  await copyFile(framePaths[2], path.join(ASSET_ROOT, 'phrio-hero.png'));
  await runCommand('magick', [
    '-delay', '115', framePaths[0],
    '-delay', '145', framePaths[1],
    '-delay', '210', framePaths[2],
    '-resize', '840x560',
    '-colors', '192',
    '-layers', 'Optimize',
    '-loop', '0',
    path.join(ASSET_ROOT, 'phrio-demo.gif'),
  ]);

  const heroDataUrl = `data:image/png;base64,${
    (await readFile(framePaths[2])).toString('base64')
  }`;
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.setContent(socialPreviewHtml(heroDataUrl), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: path.join(ASSET_ROOT, 'phrio-social-preview.png'),
    scale: 'css',
  });
} finally {
  await browser?.close().catch(() => undefined);
  await terminateProcessGroup(child).catch(() => undefined);
  await writeFile(
    path.join(OUTPUT_ROOT, 'packaged-process.log'),
    `${processLog.join('\n')}\n`,
  );
  await rm(userDataDirectory, { recursive: true, force: true });
}

const generatedAssets = [
  'phrio-hero.png',
  'phrio-demo.gif',
  'phrio-social-preview.png',
];
const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: 'real packaged Electron application with isolated blank userData',
  controlledFixtureBoundary: {
    microphoneRequested: false,
    modelInstalled: false,
    practiceRecordCreated: false,
    externalRequestCount: externalRequests.length,
    rendererErrorCount: consoleErrors.length,
  },
  assets: await Promise.all(generatedAssets.map(async (name) => {
    const bytes = await readFile(path.join(ASSET_ROOT, name));
    return {
      name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  })),
};
await writeFile(
  path.join(OUTPUT_ROOT, 'report.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(`Propagation assets captured from packaged Phrio: ${ASSET_ROOT}`);

function socialPreviewHtml(heroDataUrl) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; }
      html, body { width: 1280px; height: 640px; margin: 0; overflow: hidden; }
      body {
        position: relative;
        display: grid;
        grid-template-columns: 47% 53%;
        color: #14221e;
        background: #f1efe5;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
      }
      body::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        width: 18px;
        background: #df6749;
      }
      body::after {
        content: "";
        position: absolute;
        left: 598px;
        top: 0;
        bottom: 0;
        width: 2px;
        background: #173d34;
      }
      .copy { z-index: 1; display: flex; flex-direction: column; justify-content: center; padding: 54px 30px 48px 72px; }
      .brand { display: flex; align-items: center; gap: 16px; margin-bottom: 40px; font-size: 29px; font-weight: 760; }
      .mark { width: 58px; height: 58px; }
      h1 { max-width: 560px; margin: 0; font-size: 58px; line-height: 1.08; letter-spacing: -2.6px; }
      p { max-width: 520px; margin: 22px 0 30px; color: #425d54; font-size: 22px; line-height: 1.5; }
      .pills { display: flex; flex-wrap: wrap; gap: 9px; }
      .pills span { border: 1.5px solid #173d34; border-radius: 0; background: transparent; padding: 8px 13px; color: #173d34; font-size: 14px; font-weight: 680; }
      .app-offset { position: absolute; z-index: 0; top: 75px; right: -158px; width: 780px; height: 520px; background: #65a995; }
      .app { position: absolute; z-index: 1; top: 62px; right: -172px; width: 780px; height: 520px; overflow: hidden; border: 2px solid #173d34; border-radius: 0; background: #fff; }
      .app img { width: 780px; height: 520px; object-fit: cover; object-position: center; }
      .edition { position: absolute; z-index: 2; right: 34px; bottom: 22px; color: #173d34; font-size: 12px; font-weight: 720; letter-spacing: 2px; writing-mode: vertical-rl; }
    </style>
  </head>
  <body>
    <section class="copy">
      <div class="brand">
        <svg class="mark" viewBox="0 0 1024 1024" aria-hidden="true">
          <rect x="45" y="45" width="934" height="934" rx="220" fill="#f1efe5" stroke="#c9cec3" stroke-width="12"/>
          <path d="M406 708V360h116c100 0 166 58 166 146 0 91-66 149-166 149h-52" fill="none" stroke="#65a995" stroke-linecap="round" stroke-linejoin="round" stroke-width="94" transform="translate(36 40)"/>
          <path d="M352 760V306h170c127 0 210 74 210 190 0 118-83 192-210 192h-70" fill="none" stroke="#173d34" stroke-linecap="round" stroke-linejoin="round" stroke-width="108"/>
          <circle cx="750" cy="496" r="48" fill="#f1efe5"/>
          <circle cx="750" cy="496" r="28" fill="#df6749"/>
          <path d="M175 866h145" stroke="#173d34" stroke-linecap="round" stroke-width="11"/>
          <path d="M175 890h92" stroke="#65a995" stroke-linecap="round" stroke-width="10"/>
        </svg>
        Phrio
      </div>
      <h1>Speak once.<br>Say it again,<br>more clearly.</h1>
      <p>Evidence-linked, local-first deliberate practice for clearer Chinese spoken communication.</p>
      <div class="pills"><span>Local-first</span><span>One focus</span><span>No total score</span></div>
    </section>
    <div class="app-offset"></div>
    <div class="app"><img src="${heroDataUrl}" alt=""></div>
    <div class="edition">INTERNAL ALPHA · 01</div>
  </body>
</html>`;
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    childProcess.stdout?.on('data', (chunk) => { output += chunk.toString(); });
    childProcess.stderr?.on('data', (chunk) => { output += chunk.toString(); });
    childProcess.once('error', reject);
    childProcess.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `${command} exited with ${code ?? signal ?? 'unknown status'}\n${output.slice(-3000)}`,
      ));
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
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function captureOutput(stream, lines) {
  stream?.on('data', (chunk) => {
    lines.push(...String(chunk).split(/\r?\n/u).filter(Boolean));
    if (lines.length > 500) lines.splice(0, lines.length - 500);
  });
}

async function waitForCdp(targetPort, targetProcess, lines) {
  const endpoint = `http://127.0.0.1:${targetPort}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (targetProcess.exitCode !== null) {
      throw new Error(`Electron exited before CDP became ready.\n${lines.slice(-40).join('\n')}`);
    }
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return endpoint;
    } catch {
      // Electron is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for packaged Electron CDP.');
}

async function waitForAppPage(targetBrowser) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = targetBrowser.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => /^(?:https?:|phrio-app:)/u.test(candidate.url()));
    if (page) {
      await page.waitForLoadState('domcontentloaded');
      return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Electron did not expose an application page through CDP.');
}

async function terminateProcessGroup(targetProcess) {
  if (!targetProcess.pid || targetProcess.exitCode !== null) return;
  const exit = new Promise((resolve) => targetProcess.once('exit', resolve));
  try {
    process.kill(-targetProcess.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (targetProcess.exitCode !== null) return;
  try {
    process.kill(-targetProcess.pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

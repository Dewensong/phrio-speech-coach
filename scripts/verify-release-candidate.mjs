import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const appPath = path.resolve('out/Phrio-darwin-arm64/Phrio.app');
const makePath = path.resolve('out/make');
const releaseEvidencePath = path.resolve('out/release');

if (process.platform !== 'darwin') {
  throw new Error('The public release-candidate gate must run on macOS.');
}

await access(appPath);
await access(makePath);

const distributables = (await collectFiles(makePath))
  .filter((filePath) => filePath.endsWith('.dmg') || filePath.endsWith('.zip'))
  .sort();
const dmgPaths = distributables.filter((filePath) => filePath.endsWith('.dmg'));
const zipPaths = distributables.filter((filePath) => filePath.endsWith('.zip'));

if (dmgPaths.length !== 1) {
  throw new Error(`Expected exactly one DMG release candidate, found ${dmgPaths.length}.`);
}
if (zipPaths.length !== 1) {
  throw new Error(`Expected exactly one ZIP release candidate, found ${zipPaths.length}.`);
}

await runFile('/usr/bin/codesign', [
  '--verify',
  '--deep',
  '--strict',
  '--verbose=2',
  appPath,
]);

const signature = await captureStderr('/usr/bin/codesign', [
  '--display',
  '--verbose=4',
  appPath,
]);
if (!signature.includes('Identifier=com.phrio.desktop')) {
  throw new Error('Release candidate has the wrong application bundle identifier.');
}
if (!signature.includes('Authority=Developer ID Application:')) {
  throw new Error('Release candidate is not signed by a Developer ID Application identity.');
}
if (/TeamIdentifier=(?:not set)?\s*$/m.test(signature) || !signature.includes('TeamIdentifier=')) {
  throw new Error('Release candidate is missing an Apple Developer Team identifier.');
}
if (!signature.includes('Runtime Version=')) {
  throw new Error('Release candidate is missing the hardened runtime flag.');
}

const mainEntitlements = await captureCombined('/usr/bin/codesign', [
  '--display',
  '--entitlements',
  ':-',
  appPath,
]);
for (const requiredKey of [
  'com.apple.security.device.audio-input',
  'com.apple.security.cs.allow-jit',
]) {
  if (!mainEntitlements.includes(`<key>${requiredKey}</key>`)) {
    throw new Error(`Release candidate is missing ${requiredKey}.`);
  }
}
for (const forbiddenMarker of ['camera', 'location', 'bluetooth', 'usb']) {
  if (mainEntitlements.toLowerCase().includes(forbiddenMarker)) {
    throw new Error(`Release candidate contains a forbidden ${forbiddenMarker} entitlement marker.`);
  }
}

const info = await readInfoPlist(appPath);
if (
  typeof info.NSMicrophoneUsageDescription !== 'string'
  || info.NSMicrophoneUsageDescription.trim() === ''
) {
  throw new Error('Release candidate is missing NSMicrophoneUsageDescription.');
}
for (const key of [
  'NSAudioCaptureUsageDescription',
  'NSCameraUsageDescription',
  'NSLocationUsageDescription',
  'NSLocationWhenInUseUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSAppleEventsUsageDescription',
]) {
  if (key in info) {
    throw new Error(`Release candidate declares unnecessary macOS permission ${key}.`);
  }
}

for (const filename of [
  'Phrio-LICENSE.txt',
  'THIRD_PARTY_NOTICES.md',
  'Electron-LICENSE.txt',
  'Electron-LICENSES.chromium.html',
  'Apache-2.0.txt',
]) {
  await access(path.join(appPath, 'Contents', 'Resources', 'licenses', filename));
}

await runFile('/usr/sbin/spctl', [
  '--assess',
  '--type',
  'execute',
  '--verbose=4',
  appPath,
]);
await runFile('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
await runFile('/usr/bin/xcrun', ['stapler', 'validate', dmgPaths[0]]);

await mkdir(releaseEvidencePath, { recursive: true });
const checksums = [];
for (const filePath of distributables) {
  const digest = createHash('sha256').update(await readFile(filePath)).digest('hex');
  checksums.push(`${digest}  ${path.basename(filePath)}`);
}
await writeFile(
  path.join(releaseEvidencePath, 'SHA256SUMS.txt'),
  `${checksums.join('\n')}\n`,
  'utf8',
);

console.log(
  `Public release-candidate gate passed (${distributables.length} distributables; `
  + 'Developer ID, hardened runtime, Gatekeeper, and notarization ticket verified).',
);

async function collectFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function captureStderr(command, args) {
  const { stderr } = await runFile(command, args);
  return stderr;
}

async function captureCombined(command, args) {
  const { stdout, stderr } = await runFile(command, args);
  return `${stdout}\n${stderr}`;
}

async function readInfoPlist(applicationPath) {
  const infoPath = path.join(applicationPath, 'Contents', 'Info.plist');
  const { stdout } = await runFile('/usr/bin/plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    '--',
    infoPath,
  ]);
  return JSON.parse(stdout);
}

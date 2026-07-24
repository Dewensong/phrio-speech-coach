import { execFile } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const appPath = path.resolve('out/Phrio-darwin-arm64/Phrio.app');
const allowedMainEntitlements = new Set(['com.apple.security.device.audio-input']);
const forbiddenPermissionMarkers = [
  'camera',
  'location',
  'bluetooth',
  'usb',
  'print',
];

if (process.platform !== 'darwin') {
  throw new Error('The packaged macOS signing gate must run on macOS.');
}

await access(appPath);
await runFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);

const { stderr: identityOutput } = await runFile('/usr/bin/codesign', [
  '--display',
  '--verbose=4',
  appPath,
]);
if (!identityOutput.includes('Identifier=com.phrio.desktop')) {
  throw new Error('Packaged application bundle identifier is not com.phrio.desktop.');
}

const signedTargets = await collectSignedTargets(appPath);
for (const target of signedTargets) {
  const entitlementOutput = await readEntitlements(target);
  const keys = [...entitlementOutput.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
  for (const key of keys) {
    if (target === appPath && allowedMainEntitlements.has(key)) continue;
    throw new Error(`Unexpected entitlement ${key} on ${path.relative(appPath, target) || 'Phrio.app'}.`);
  }
  const lower = entitlementOutput.toLowerCase();
  for (const marker of forbiddenPermissionMarkers) {
    if (lower.includes(marker)) {
      throw new Error(`Forbidden ${marker} entitlement marker on ${target}.`);
    }
  }
}

const mainEntitlements = await readEntitlements(appPath);
if (!mainEntitlements.includes('<key>com.apple.security.device.audio-input</key>')) {
  throw new Error('Packaged application is missing the microphone audio-input entitlement.');
}

const infoPlist = await readFile(path.join(appPath, 'Contents', 'Info.plist'));
const { stdout: infoJson } = await runFile('/usr/bin/plutil', [
  '-convert',
  'json',
  '-o',
  '-',
  '--',
  path.join(appPath, 'Contents', 'Info.plist'),
]);
const info = JSON.parse(infoJson);
if (
  typeof info.NSMicrophoneUsageDescription !== 'string'
  || info.NSMicrophoneUsageDescription.trim() === ''
) {
  throw new Error('Packaged application is missing NSMicrophoneUsageDescription.');
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
  if (key in info) throw new Error(`Packaged Info.plist includes unnecessary permission ${key}.`);
}
if (infoPlist.length === 0) throw new Error('Packaged Info.plist is empty.');

const requiredLicenseFiles = [
  'Phrio-LICENSE.txt',
  'THIRD_PARTY_NOTICES.md',
  'Electron-LICENSE.txt',
  'Electron-LICENSES.chromium.html',
  'React-LICENSE.txt',
  'React-DOM-LICENSE.txt',
  'Scheduler-LICENSE.txt',
  'Lucide-LICENSE.txt',
  'Zod-LICENSE.txt',
  'Apache-2.0.txt',
];
const licenseDirectory = path.join(appPath, 'Contents', 'Resources', 'licenses');
for (const filename of requiredLicenseFiles) {
  const file = await stat(path.join(licenseDirectory, filename));
  if (!file.isFile() || file.size === 0) {
    throw new Error(`Packaged application has an invalid license resource: ${filename}.`);
  }
}

console.log(`macOS package gate passed (${signedTargets.length} signed targets).`);

async function collectSignedTargets(root) {
  const targets = [root];
  await walk(path.join(root, 'Contents'), async (entryPath, entry) => {
    if (
      entry.isDirectory()
      && (entry.name.endsWith('.app') || entry.name.endsWith('.framework'))
    ) targets.push(entryPath);
    if (
      entry.isFile()
      && (entry.name.endsWith('.dylib') || entry.name.endsWith('.node'))
    ) targets.push(entryPath);
  });
  return [...new Set(targets)];
}

async function walk(directory, visit) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    await visit(entryPath, entry);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(entryPath, visit);
  }
}

async function readEntitlements(target) {
  try {
    const { stdout, stderr } = await runFile('/usr/bin/codesign', [
      '--display',
      '--entitlements',
      ':-',
      target,
    ]);
    return `${stdout}\n${stderr}`;
  } catch (error) {
    throw new Error(`Unable to inspect entitlements for ${target}: ${String(error)}`);
  }
}

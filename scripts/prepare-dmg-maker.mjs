import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const resolvePackage = createRequire(import.meta.url);

if (process.platform !== 'darwin') {
  console.log('DMG native prerequisites are only required on macOS.');
  process.exit(0);
}

const nativePackages = [
  { name: 'macos-alias', binary: 'build/Release/volume.node' },
  { name: 'fs-xattr', binary: 'build/Release/xattr.node' },
];

for (const nativePackage of nativePackages) {
  const packageDirectory = path.dirname(
    resolvePackage.resolve(`${nativePackage.name}/package.json`),
  );
  const binaryPath = path.join(packageDirectory, nativePackage.binary);
  if (await exists(binaryPath)) continue;
  await rebuildNativePackage(nativePackage.name, packageDirectory);
  if (!await exists(binaryPath)) {
    throw new Error(
      `${nativePackage.name} completed its native build without producing `
      + nativePackage.binary,
    );
  }
}

console.log('DMG native prerequisites are ready.');

async function rebuildNativePackage(packageName, packageDirectory) {
  const nodeGypPath = resolvePackage.resolve('@electron/node-gyp/bin/node-gyp.js');
  const childEnvironment = {
    ...process.env,
    npm_config_loglevel: 'error',
  };
  const result = await run(process.execPath, [
    nodeGypPath,
    'rebuild',
    '--directory',
    packageDirectory,
  ], childEnvironment);
  if (result.code !== 0) {
    throw new Error(
      `Unable to compile the ${packageName} DMG prerequisite (exit ${result.code}).\n`
      + redactEnvironmentValues(result.output),
    );
  }
}

async function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, output: output.slice(-5000) });
    });
  });
}

function redactEnvironmentValues(output) {
  let redacted = output;
  for (const value of Object.values(process.env)) {
    if (typeof value === 'string' && value.length >= 8) {
      redacted = redacted.replaceAll(value, '[redacted]');
    }
  }
  return redacted;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

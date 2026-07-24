import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const iconSource = path.resolve('build/brand/phrio-icon.svg');
const iconPng = path.resolve('build/brand/phrio-icon-1024.png');
const iconIcns = path.resolve('build/brand/Phrio.icns');
const dmgSource = path.resolve('build/brand/dmg-background.svg');
const dmgPng = path.resolve('build/brand/dmg-background.png');

if (process.platform !== 'darwin') {
  throw new Error('Phrio macOS brand assets must be built on macOS.');
}

await runFile('rsvg-convert', ['-w', '1024', '-h', '1024', iconSource, '-o', iconPng]);
await runFile('rsvg-convert', ['-w', '658', '-h', '498', dmgSource, '-o', dmgPng]);

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'phrio-brand-'));
const iconsetDirectory = path.join(temporaryDirectory, 'Phrio.iconset');

try {
  await mkdir(iconsetDirectory, { recursive: true });
  const outputs = [
    { size: 16, name: 'icon_16x16.png' },
    { size: 32, name: 'icon_16x16@2x.png' },
    { size: 32, name: 'icon_32x32.png' },
    { size: 64, name: 'icon_32x32@2x.png' },
    { size: 128, name: 'icon_128x128.png' },
    { size: 256, name: 'icon_128x128@2x.png' },
    { size: 256, name: 'icon_256x256.png' },
    { size: 512, name: 'icon_256x256@2x.png' },
    { size: 512, name: 'icon_512x512.png' },
    { size: 1024, name: 'icon_512x512@2x.png' },
  ];
  for (const output of outputs) {
    await runFile('sips', [
      '-z',
      String(output.size),
      String(output.size),
      iconPng,
      '--out',
      path.join(iconsetDirectory, output.name),
    ]);
  }
  await runFile('iconutil', ['-c', 'icns', iconsetDirectory, '-o', iconIcns]);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log('Phrio brand assets rebuilt with transparent macOS icon corners.');

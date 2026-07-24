// @vitest-environment node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('macOS package permission gate', () => {
  it('keeps the main entitlement to microphone input and gives helpers none', async () => {
    const main = await readFile(path.resolve('build/entitlements.mac.plist'), 'utf8');
    const inherit = await readFile(path.resolve('build/entitlements.mac.inherit.plist'), 'utf8');
    const forge = await readFile(path.resolve('forge.config.ts'), 'utf8');

    expect(main.match(/<key>[^<]+<\/key>/g)).toEqual([
      '<key>com.apple.security.device.audio-input</key>',
    ]);
    expect(inherit).not.toMatch(/<key>/);
    expect(forge).toContain('entitlements.mac.plist');
    expect(forge).toContain('entitlements.mac.inherit.plist');
    expect(forge).toContain('preAutoEntitlements: false');
  });

  it('rejects accidental camera, location, bluetooth, USB or print permissions by package gate', async () => {
    const gate = (await readFile(path.resolve('scripts/verify-packaged-macos.mjs'), 'utf8'))
      .toLowerCase();
    for (const marker of ['camera', 'location', 'bluetooth', 'usb', 'print']) {
      expect(gate).toContain(`'${marker}'`);
    }
    expect(gate).toContain("'--deep'");
    expect(gate).toContain("'--strict'");
  });
});

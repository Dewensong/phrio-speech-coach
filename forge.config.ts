import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { execFile } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

const resolvePackage = createRequire(import.meta.url);
const runFile = promisify(execFile);
const releaseSigningEnabled = process.env.PHRIO_RELEASE_SIGNING === '1';
const UNUSED_MACOS_USAGE_DESCRIPTION_KEYS = [
  'NSCameraUsageDescription',
  'NSLocationUsageDescription',
  'NSLocationWhenInUseUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSAudioCaptureUsageDescription',
] as const;

async function stripUnusedMacosUsageDescriptions(buildPath: string): Promise<void> {
  const infoPlistPath = path.join(buildPath, 'Phrio.app', 'Contents', 'Info.plist');
  const { stdout } = await runFile('/usr/bin/plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    '--',
    infoPlistPath,
  ]);
  const info = JSON.parse(stdout) as Readonly<Record<string, unknown>>;
  for (const key of UNUSED_MACOS_USAGE_DESCRIPTION_KEYS) {
    if (!(key in info)) continue;
    await runFile('/usr/bin/plutil', ['-remove', key, '--', infoPlistPath]);
  }
}

async function copyDistributionLicenses(buildPath: string): Promise<void> {
  const licenseDirectory = path.join(
    buildPath,
    'Phrio.app',
    'Contents',
    'Resources',
    'licenses',
  );
  await mkdir(licenseDirectory, { recursive: true });
  const licenseFiles = [
    { source: path.resolve('LICENSE'), target: 'Phrio-LICENSE.txt' },
    { source: path.resolve('THIRD_PARTY_NOTICES.md'), target: 'THIRD_PARTY_NOTICES.md' },
    { source: path.resolve('node_modules/electron/dist/LICENSE'), target: 'Electron-LICENSE.txt' },
    {
      source: path.resolve('node_modules/electron/dist/LICENSES.chromium.html'),
      target: 'Electron-LICENSES.chromium.html',
    },
    { source: path.resolve('node_modules/react/LICENSE'), target: 'React-LICENSE.txt' },
    { source: path.resolve('node_modules/react-dom/LICENSE'), target: 'React-DOM-LICENSE.txt' },
    { source: path.resolve('node_modules/scheduler/LICENSE'), target: 'Scheduler-LICENSE.txt' },
    { source: path.resolve('node_modules/lucide-react/LICENSE'), target: 'Lucide-LICENSE.txt' },
    { source: path.resolve('node_modules/zod/LICENSE'), target: 'Zod-LICENSE.txt' },
    {
      // sherpa-onnx-node declares Apache-2.0 but its npm package does not ship
      // a LICENSE file. Playwright carries the canonical Apache-2.0 text.
      source: path.resolve('node_modules/playwright-core/LICENSE'),
      target: 'Apache-2.0.txt',
    },
  ];
  await Promise.all(licenseFiles.map(({ source, target }) => (
    cp(source, path.join(licenseDirectory, target), { force: true })
  )));
}

async function copyPackagedAsrDependencies(
  buildPath: string,
  platform: string,
  arch: string,
): Promise<void> {
  const sherpaPlatform = platform === 'win32' ? 'win' : platform;
  const packageNames = [
    'sherpa-onnx-node',
    `sherpa-onnx-${sherpaPlatform}-${arch}`,
  ];
  const nodeModulesDirectory = path.join(buildPath, 'node_modules');
  await mkdir(nodeModulesDirectory, { recursive: true });

  for (const packageName of packageNames) {
    const sourceDirectory = path.dirname(
      resolvePackage.resolve(`${packageName}/package.json`),
    );
    await cp(sourceDirectory, path.join(nodeModulesDirectory, packageName), {
      recursive: true,
      dereference: true,
      force: true,
    });
  }
}

function releaseEntitlementsFor(filePath: string): string {
  if (filePath.includes('(Plugin).app')) {
    return path.resolve('build/entitlements.mac.release.plugin.plist');
  }
  if (filePath.includes('(GPU).app') || filePath.includes('(Renderer).app')) {
    return path.resolve('build/entitlements.mac.release.jit.plist');
  }
  if (filePath.endsWith(`${path.sep}Phrio.app`)) {
    return path.resolve('build/entitlements.mac.release.plist');
  }
  return path.resolve('build/entitlements.mac.inherit.plist');
}

function releaseNotarizationConfig() {
  const keychainProfile = process.env.APPLE_NOTARY_KEYCHAIN_PROFILE;
  if (keychainProfile) return { keychainProfile };
  const appleApiKey = process.env.APPLE_API_KEY;
  const appleApiKeyId = process.env.APPLE_API_KEY_ID;
  const appleApiIssuer = process.env.APPLE_API_ISSUER;
  if (appleApiKey && appleApiKeyId && appleApiIssuer) {
    return { appleApiKey, appleApiKeyId, appleApiIssuer };
  }
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_ID_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (appleId && appleIdPassword && teamId) {
    return { appleId, appleIdPassword, teamId };
  }
  throw new Error(
    'PHRIO_RELEASE_SIGNING=1 requires APPLE_NOTARY_KEYCHAIN_PROFILE, '
    + 'App Store Connect API key variables, or Apple ID notarization variables.',
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      // Electron cannot dlopen native addons or their dylibs from inside app.asar.
      unpackDir: path.join('node_modules', 'sherpa-onnx-*'),
    },
    executableName: 'Phrio',
    appBundleId: 'com.phrio.desktop',
    appCategoryType: 'public.app-category.education',
    icon: path.resolve('build/brand/Phrio.icns'),
    // This machine has no Developer ID identity. A complete post-fuse ad-hoc
    // signature keeps the internal alpha's bundle identifier stable and avoids
    // shipping an invalid inherited Electron signature. Its cdhash changes on
    // rebuild, so it does not guarantee macOS TCC continuity.
    // Public distribution must replace this with hardened Developer ID signing
    // and notarization.
    osxSign: process.platform === 'darwin'
      ? releaseSigningEnabled
        ? {
            identity: process.env.APPLE_SIGNING_IDENTITY ?? 'Developer ID Application',
            identityValidation: true,
            preAutoEntitlements: false,
            preEmbedProvisioningProfile: false,
            optionsForFile: (filePath) => ({
              entitlements: releaseEntitlementsFor(filePath),
              hardenedRuntime: true,
            }),
          }
        : {
          identity: '-',
          identityValidation: false,
          preAutoEntitlements: false,
          preEmbedProvisioningProfile: false,
          optionsForFile: (filePath) => ({
            entitlements: filePath.endsWith(`${path.sep}Phrio.app`)
              ? path.resolve('build/entitlements.mac.plist')
              : path.resolve('build/entitlements.mac.inherit.plist'),
            hardenedRuntime: false,
            timestamp: 'none',
          }),
          }
      : undefined,
    osxNotarize: process.platform === 'darwin' && releaseSigningEnabled
      ? releaseNotarizationConfig()
      : undefined,
    extendInfo: {
      NSMicrophoneUsageDescription: 'Phrio 仅在你主动开始练习时使用麦克风，并默认在本地处理录音。',
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
      },
    },
    // Electron's template Info.plist includes generic camera/Bluetooth usage
    // strings. An explicit empty extra-resource phase gives Packager a hook
    // after plist generation and before signing, where those unused keys can
    // be removed without invalidating the final signature.
    extraResource: [],
    afterCopyExtraResources: [
      (buildPath, _electronVersion, platform, _arch, callback) => {
        if (platform !== 'darwin') {
          callback();
          return;
        }
        void Promise.all([
          stripUnusedMacosUsageDescriptions(buildPath),
          copyDistributionLicenses(buildPath),
        ]).then(
          () => callback(),
          (error: Error) => callback(error),
        );
      },
    ],
  },
  rebuildConfig: {},
  hooks: {
    // The Vite plugin intentionally copies only .vite output. Add the two runtime
    // packages after dependency pruning so the dynamic main-process require works.
    packageAfterPrune: async (_forgeConfig, buildPath, _electronVersion, platform, arch) => {
      await copyPackagedAsrDependencies(buildPath, platform, arch);
    },
  },
  makers: [
    new MakerZIP({}, ['darwin']),
    new MakerDMG({
      background: path.resolve('build/brand/dmg-background.png'),
      icon: path.resolve('build/brand/Phrio.icns'),
      iconSize: 104,
      overwrite: true,
      format: 'ULFO',
      additionalDMGOptions: {
        window: {
          size: { width: 658, height: 498 },
        },
      },
    }, ['darwin']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/backend/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/index.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      strictlyRequireAllFuses: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.WasmTrapHandlers]: true,
    }),
  ],
};

export default config;

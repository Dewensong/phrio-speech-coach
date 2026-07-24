import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const repositoryRoot = process.cwd();
const packageMetadata = JSON.parse(
  await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
);
const applicationPath = path.join(
  repositoryRoot,
  'out',
  'Phrio-darwin-arm64',
  'Phrio.app',
);
const outputDirectory = path.join(repositoryRoot, 'out', 'ci');

await access(applicationPath);

if (process.env.PHRIO_CI_GATE_PASSED !== '1') {
  throw new Error(
    'Refusing to create CI evidence without a successful pnpm verify gate.',
  );
}

const commitSha = process.env.GITHUB_SHA || await git('rev-parse', 'HEAD');
const shortCommitSha = commitSha.slice(0, 12);
const workingTreeStatus = await git('status', '--porcelain=v1');

if (process.env.CI && workingTreeStatus !== '') {
  throw new Error('CI evidence must be generated from a clean tracked working tree.');
}

const sourceLabel = workingTreeStatus === ''
  ? shortCommitSha
  : `${shortCommitSha}-dirty`;
const archiveName = [
  'Phrio',
  packageMetadata.version,
  sourceLabel,
  'macOS-arm64-ad-hoc.zip',
].join('-');
const archivePath = path.join(outputDirectory, archiveName);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await runFile('/usr/bin/ditto', [
  '-c',
  '-k',
  '--sequesterRsrc',
  '--keepParent',
  applicationPath,
  archivePath,
]);

const archiveHash = await sha256File(archivePath);
const archiveStat = await stat(archivePath);
const { stdout: infoJson } = await runFile('/usr/bin/plutil', [
  '-convert',
  'json',
  '-o',
  '-',
  '--',
  path.join(applicationPath, 'Contents', 'Info.plist'),
]);
const info = JSON.parse(infoJson);
const { stdout: signatureStdout, stderr: signatureStderr } = await runFile(
  '/usr/bin/codesign',
  ['--display', '--verbose=4', applicationPath],
);
const signatureDetails = `${signatureStdout}\n${signatureStderr}`;

const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidenceClasses: {
    automated: {
      status: 'passed',
      command: 'pnpm verify',
      scope: [
        'TypeScript typecheck',
        'unit and integration test suite',
        'Electron system-network and power-blocker probes',
        'macOS package and entitlement gate',
        'packaged preload bridge smoke',
        'packaged Sherpa native dependency smoke',
      ],
    },
    controlledFixture: {
      status: 'not_run',
      note: 'The visual and product-tour fixture lanes are not part of this minimal CI job.',
    },
    realDevice: {
      status: 'not_run',
      note: 'Microphone, device interruption, model quality, target-Mac performance, and real OpenAI calls require separate human acceptance.',
    },
  },
  source: {
    repository: process.env.GITHUB_REPOSITORY || null,
    commitSha,
    ref: process.env.GITHUB_REF || null,
    eventName: process.env.GITHUB_EVENT_NAME || null,
    runUrl: githubRunUrl(),
    workingTreeClean: workingTreeStatus === '',
  },
  toolchain: {
    os: `${os.platform()} ${os.release()}`,
    architecture: process.arch,
    node: process.version,
    pnpm: await commandVersion('pnpm'),
  },
  application: {
    packageName: packageMetadata.name,
    productName: packageMetadata.productName,
    packageVersion: packageMetadata.version,
    bundleIdentifier: info.CFBundleIdentifier,
    bundleShortVersion: info.CFBundleShortVersionString,
    bundleVersion: info.CFBundleVersion,
    signature: extractCodeSignField(signatureDetails, 'Signature'),
    teamIdentifier: extractCodeSignField(signatureDetails, 'TeamIdentifier'),
    distributionBoundary: 'ad-hoc internal Alpha; not Developer ID signed or notarized',
  },
  artifact: {
    file: archiveName,
    bytes: archiveStat.size,
    sha256: archiveHash,
    retentionDays: 14,
  },
  privacyBoundary: {
    openAiCredentialsProvided: false,
    openAiRequestAuthorizedOrSent: false,
    realTranscriptIncluded: false,
    modelWeightsIncluded: false,
  },
};

const evidenceName = `Phrio-${packageMetadata.version}-${sourceLabel}-ci-evidence.json`;
await writeFile(
  path.join(outputDirectory, evidenceName),
  `${JSON.stringify(evidence, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o600 },
);
await writeFile(
  path.join(outputDirectory, `${archiveName}.sha256`),
  `${archiveHash}  ${archiveName}\n`,
  { encoding: 'utf8', mode: 0o600 },
);

console.log(`Created ${path.relative(repositoryRoot, archivePath)}`);
console.log(`SHA-256 ${archiveHash}`);
console.log('Evidence class: automated; real-device acceptance not run');

async function git(...args) {
  const { stdout } = await runFile('git', args, { cwd: repositoryRoot });
  return stdout.trim();
}

async function commandVersion(command) {
  const { stdout } = await runFile(command, ['--version']);
  return stdout.trim();
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function extractCodeSignField(output, field) {
  const match = output.match(new RegExp(`^${field}=(.+)$`, 'mu'));
  return match?.[1] ?? null;
}

function githubRunUrl() {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!repository || !runId) return null;
  return `https://github.com/${repository}/actions/runs/${runId}`;
}

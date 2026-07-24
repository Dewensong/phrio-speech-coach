import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const repositoryRoot = process.cwd();

const requiredFiles = [
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'pnpm-lock.yaml',
  '.npmrc',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/bug-report.yml',
  '.github/ISSUE_TEMPLATE/feature-request.yml',
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/release-candidate.yml',
  'docs/release/github-open-source-readiness.md',
];

const forbiddenTrackedPathRules = [
  {
    label: 'environment file',
    pattern: /(?:^|\/)\.env(?:\.|$)/iu,
  },
  {
    label: 'credential or signing material',
    pattern: /\.(?:p8|p12|mobileprovision|key|pem|cer|crt)$/iu,
  },
  {
    label: 'real audio or recording',
    pattern: /\.(?:wav|mp3|m4a|aac|flac|ogg|webm)$/iu,
  },
  {
    label: 'local database',
    pattern: /\.(?:sqlite|sqlite3|db)(?:-(?:shm|wal))?$/iu,
  },
  {
    label: 'model weight',
    pattern: /\.(?:onnx|safetensors|pt|pth)$/iu,
  },
  {
    label: 'built installer or archive',
    pattern: /\.(?:dmg|pkg|zip)$/iu,
  },
  {
    label: 'generated dependency or build directory',
    pattern: /(?:^|\/)(?:node_modules|\.vite|out|dist)(?:\/|$)/iu,
  },
];

const textExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.mts',
  '.plist',
  '.svg',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const forbiddenContentRules = [
  {
    label: 'private key block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  },
  {
    label: 'GitHub access token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
  },
  {
    label: 'AWS access key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/u,
  },
  {
    label: 'Slack access token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  },
  {
    label: 'OpenAI-style API key',
    pattern: /(?:^|[^A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/u,
  },
  {
    label: 'workstation-specific absolute path',
    pattern: /\/Users\/[A-Za-z0-9._-]+\//u,
  },
];

for (const relativePath of requiredFiles) {
  await access(path.join(repositoryRoot, relativePath));
}

const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
);
const npmConfiguration = await readFile(path.join(repositoryRoot, '.npmrc'), 'utf8');
const npmConfigurationLines = npmConfiguration
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter(Boolean);
assert(packageJson.private === true, 'package.json must keep npm publication disabled.');
assert(packageJson.license === 'MIT', 'package.json license must match LICENSE.');
assert(
  packageJson.packageManager === 'pnpm@10.33.2',
  'packageManager must keep the reviewed pnpm version.',
);
assert(
  packageJson.scripts?.verify?.includes('verify:open-source'),
  'The production gate must include verify:open-source.',
);
assert(
  npmConfigurationLines.length === 2
    && npmConfigurationLines.includes('node-linker=hoisted')
    && npmConfigurationLines.includes('loglevel=error'),
  '.npmrc must keep the reviewed hoisted layout, suppress environment dumps, '
    + 'and contain no registry, mirror, or authentication configuration.',
);

const { stdout: trackedOutput } = await runFile('git', ['ls-files', '-z'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
});
const trackedFiles = trackedOutput.split('\0').filter(Boolean);

const pathFailures = [];
const contentFailures = [];
for (const relativePath of trackedFiles) {
  const normalizedPath = relativePath.replaceAll('\\', '/');
  for (const rule of forbiddenTrackedPathRules) {
    if (rule.pattern.test(normalizedPath)) {
      pathFailures.push(`${rule.label}: ${normalizedPath}`);
    }
  }

  const isTextFile = textExtensions.has(path.extname(normalizedPath).toLowerCase())
    || path.basename(normalizedPath) === '.npmrc';
  if (!isTextFile) continue;
  const content = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
  for (const rule of forbiddenContentRules) {
    if (rule.pattern.test(content)) {
      contentFailures.push(`${rule.label}: ${normalizedPath}`);
    }
  }
}

assert(
  pathFailures.length === 0,
  `Forbidden tracked files:\n${pathFailures.map((item) => `- ${item}`).join('\n')}`,
);
assert(
  contentFailures.length === 0,
  `Potential secret or private path in the tracked tree:\n${
    contentFailures.map((item) => `- ${item}`).join('\n')
  }`,
);

const ciWorkflow = await readFile(
  path.join(repositoryRoot, '.github/workflows/ci.yml'),
  'utf8',
);
const releaseWorkflow = await readFile(
  path.join(repositoryRoot, '.github/workflows/release-candidate.yml'),
  'utf8',
);

assert(ciWorkflow.includes('      - main'), 'CI push gate must target main.');
assert(!ciWorkflow.includes('pull_request_target:'), 'CI must not use pull_request_target.');
assert(!ciWorkflow.includes('contents: write'), 'CI must keep read-only contents permission.');
assert(!ciWorkflow.includes('secrets.'), 'Internal CI must not reference repository secrets.');
assertCheckoutIsReadOnly(ciWorkflow, 'CI');

assert(
  releaseWorkflow.includes('workflow_dispatch:'),
  'Release candidate workflow must remain manually dispatched.',
);
assert(
  !releaseWorkflow.includes('\n  push:') && !releaseWorkflow.includes('\n  pull_request:'),
  'Release candidate workflow must not run on push or pull requests.',
);
assert(
  releaseWorkflow.includes('environment: macos-release-candidate'),
  'Release candidate workflow must use the protected candidate environment.',
);
assert(
  releaseWorkflow.includes('test "${GITHUB_REF}" = "refs/heads/main"'),
  'Release candidate workflow must refuse non-main source revisions.',
);
assert(
  !releaseWorkflow.includes('contents: write'),
  'Release candidate workflow must keep read-only contents permission.',
);
assert(
  !releaseWorkflow.includes('gh release') && !releaseWorkflow.includes('create-release'),
  'Release candidate workflow must not publish a GitHub Release.',
);
assertCheckoutIsReadOnly(releaseWorkflow, 'Release candidate');
assertNoJobScopedSecrets(releaseWorkflow);
assertCredentialMaterializationOrder(releaseWorkflow);
assertActionsArePinned(ciWorkflow, 'CI');
assertActionsArePinned(releaseWorkflow, 'Release candidate');

console.log(
  `Open-source readiness gate passed (${trackedFiles.length} tracked files; current tree only).`,
);

function assertCheckoutIsReadOnly(workflow, label) {
  const checkoutBlocks = workflow.match(
    /uses:\s+actions\/checkout@[0-9a-f]{40}[\s\S]*?(?=\n\s{6}- name:|\n\s{4}\S|\s*$)/gu,
  ) ?? [];
  assert(checkoutBlocks.length > 0, `${label} workflow must check out source.`);
  for (const block of checkoutBlocks) {
    assert(
      block.includes('persist-credentials: false'),
      `${label} checkout must disable persisted credentials.`,
    );
  }
}

function assertNoJobScopedSecrets(workflow) {
  const stepsIndex = workflow.indexOf('\n    steps:');
  assert(stepsIndex >= 0, 'Release candidate workflow is missing steps.');
  const jobHeader = workflow.slice(0, stepsIndex);
  assert(
    !jobHeader.includes('secrets.'),
    'Apple credentials must not be exposed through job-level environment variables.',
  );
}

function assertCredentialMaterializationOrder(workflow) {
  const installIndex = workflow.indexOf('- name: Install locked dependencies');
  const verifyIndex = workflow.indexOf('- name: Run automated production gate');
  const credentialCheckIndex = workflow.indexOf('- name: Confirm required release credentials');
  const certificateIndex = workflow.indexOf('- name: Import Developer ID identity');
  const apiKeyIndex = workflow.indexOf('- name: Prepare App Store Connect API key');
  assert(
    [installIndex, verifyIndex, credentialCheckIndex, certificateIndex, apiKeyIndex]
      .every((index) => index >= 0),
    'Release candidate workflow is missing a dependency, gate, or credential step.',
  );
  assert(
    installIndex < verifyIndex
      && verifyIndex < credentialCheckIndex
      && credentialCheckIndex < certificateIndex
      && certificateIndex < apiKeyIndex,
    'Dependencies and pnpm verify must complete before Apple credentials are materialized.',
  );
}

function assertActionsArePinned(workflow, label) {
  const uses = [...workflow.matchAll(/^\s*uses:\s+[^@\s]+@([^\s#]+)/gmu)];
  assert(uses.length > 0, `${label} workflow has no actions to verify.`);
  for (const match of uses) {
    assert(
      /^[0-9a-f]{40}$/u.test(match[1]),
      `${label} workflow action is not pinned to a full commit SHA.`,
    );
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

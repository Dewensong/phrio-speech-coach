# Contributing to Phrio

Thank you for helping people practise clearer spoken communication while keeping
their data and decisions under their control.

## Before you start

- Search existing issues and discussions when the public repository is
  available.
- Keep changes focused. Product-wide changes to evidence semantics, privacy,
  scoring, cloud providers, or persistence require an issue and an ADR first.
- Do not include real recordings, transcripts, API keys, customer information,
  proprietary prompts, model weights, or notarization credentials.
- Phrio does not output total scores, personality judgments, red/green
  winner-loss framing, or professional labels.

## Development setup

Requirements are macOS on Apple Silicon, Node.js `24.18.0+`, and pnpm
`10.33.2`.

```bash
pnpm install --frozen-lockfile
pnpm start
```

Before submitting:

```bash
pnpm verify
```

UI changes should also run:

```bash
pnpm verify:electron-visual
pnpm verify:electron-product-tour
```

State clearly which evidence category your change provides:

- automated;
- controlled fixture;
- real device or service.

Do not describe fixture output as real-device evidence.

## Architecture boundaries

- Frontend: Page → Component → Hook/Service.
- Desktop: IPC Controller → Service → Repository.
- Shared modules contain pure types, schemas, and deterministic domain logic.
- The renderer cannot access Node.js, SQLite, files, or secrets directly.
- Every desktop bridge input and output is schema validated.
- Cloud calls require a fixed provider boundary and purpose-matched consent.

Read `AGENTS.md`, `docs/adr/0001-desktop-foundation.md`,
`docs/adr/0002-fast-deep-lanes.md`, and
`docs/adr/0003-open-source-propagation-and-release.md` before changing these
boundaries.

## Community task packs

Task packs are a good first contribution. Follow
[`task-packs/README.md`](task-packs/README.md). Contributions must be original,
MIT-licensed, free of private material, and reference only existing Phrio
criteria.

## Pull requests

Include:

1. the problem and user impact;
2. the product/privacy boundary affected;
3. screenshots for visible changes;
4. exact validation commands and results;
5. remaining real-device or service boundaries.

By contributing, you agree that your contribution is licensed under the MIT
License.

# GitHub source-release readiness

This checklist governs publication of the Phrio source repository. It does not
authorize a public macOS binary, an OpenAI request, a tag, or a GitHub Release.

## Current status

| Boundary | Current state |
| --- | --- |
| Product source of truth | local `main` |
| `main` establishment base | `cd4e33bf0939314fa85f46b500c48d1c705688ca` |
| Historical acceptance ref | `codex/record-result-evidence-views`, equal at establishment |
| Remote | none |
| Source license | MIT |
| Public binary | none; current package remains ad hoc |
| Required CI check | `verify-macos-arm64` |

The repository already contains bilingual entry documentation, contribution
and conduct policies, a security policy, third-party notices, structured Issue
and pull-request templates, Dependabot configuration, a controlled demo, and
privacy-safe social assets.

## Repeatable local gate

Run:

```bash
pnpm verify:open-source
```

The gate checks the current tracked tree for:

- required community, license, CI, and release-boundary files;
- tracked environment files, signing material, real audio, local databases,
  model weights, installers, archives, or build directories;
- high-confidence private keys and provider tokens;
- workstation-specific absolute paths;
- a credential-free `.npmrc` that keeps the reviewed hoisted dependency layout,
  suppresses native build-tool environment expansion, and does not force a
  registry or Electron mirror;
- npm publication protection and MIT metadata;
- read-only, commit-pinned GitHub Actions checkout;
- credential-free Internal Alpha CI;
- a manual-only, `main`-only, non-publishing public candidate workflow whose
  Apple credentials are not exposed at job scope and are materialized only
  after dependency installation and `pnpm verify`.

This gate deliberately checks the current tree, not every historical blob.
It is included in `pnpm verify`.

## One-time audit result

The 2026-07-24 local audit found:

- no tracked `.env`, Apple certificate/key, real audio, SQLite database, model
  weight, DMG, ZIP, or other distributable;
- no current high-confidence credential after test values were changed to
  explicit non-production formats;
- native dependency install logs use project `loglevel=error`; `.npmrc` is
  itself checked to contain no registry, mirror, or authentication
  configuration;
- the largest historical blob was below 300 KiB, with no model or recording
  object found by path;
- public-facing current files were normalized to remove workstation-specific
  absolute paths;
- the repository history still contains a maintainer email address and older
  workstation paths.

The last item is a human privacy decision. Before any public push, choose one:

1. keep the complete development history and explicitly accept that metadata;
2. approve a separately designed history-cleaning operation after making an
   offline bundle and reviewing the changed commit identities.

No history rewrite has been performed. Do not improvise one after a remote has
been published.

A sanitized clean-source clone of
`6405179a9e55af2ff782dbf90bc7b8d3ff5d1e3d` passed locked installation, the
fixture-sentinel log check, and the complete production gate while reusing
reviewed local dependency caches and explicitly selecting the official Electron
Release source. Two isolated empty-HOME cold-cache attempts did not complete
the Electron download inside the bounded local window and were stopped. They
are not counted as passes; an actual GitHub-hosted runner must still prove the
cold remote path.

## Recommended remote sequence

Use an empty private repository first:

1. Record `git rev-parse main`, confirm a clean worktree, and optionally create
   an offline `git bundle --all`.
2. Decide the history/privacy option above.
3. Choose the final repository owner and slug. Do not initialize the remote
   with a README, license, or `.gitignore`.
4. With separate maintainer approval, add `origin` and push only `main`.
5. Set `main` as the default branch and wait for `verify-macos-arm64`.
6. Compare the remote SHA and CI evidence JSON with the intended local SHA.
7. Clone into a new empty directory, run `pnpm install --frozen-lockfile`,
   `pnpm verify:open-source`, and the standard gate appropriate to that Mac.
8. Only after the clean-clone result is accepted should repository visibility
   be changed to public.

Remote configuration and push commands are intentionally not embedded in an
automatic script.

## GitHub repository settings

Before public visibility:

- protect `main`; block force-push and deletion;
- require pull requests, resolved conversations, and branches to be current;
- require the exact `verify-macos-arm64` status check;
- keep default workflow permissions read-only;
- enable dependency alerts, security updates, secret scanning, push
  protection, and Private Vulnerability Reporting where the account supports
  them;
- create the labels referenced by Issue templates, Dependabot, and release
  notes;
- upload `docs/assets/phrio-social-preview.png` as the repository social image;
- create the `macos-release-candidate` Environment, restrict it to `main`, and
  require a maintainer reviewer;
- store Apple release credentials in that Environment only when a notarized
  candidate is actually in scope.

Do not add an OpenAI API key to Actions. Real OpenAI transcript transmission is
a product consent event, not a CI function.

## Honest release boundary

A green source CI result is automated evidence. The controlled Electron demo
and product tour remain fixture evidence. Neither proves real microphone
behavior, local-model quality, target-Mac performance, Developer ID signing,
notarization, Gatekeeper, TCC continuity, or an authorized OpenAI call.

Publishing the source may proceed before publishing a binary, provided the
history/privacy choice and clean-clone gate are complete. Publishing a public
DMG or ZIP remains blocked by
[Public macOS distribution](public-macos-distribution.md).

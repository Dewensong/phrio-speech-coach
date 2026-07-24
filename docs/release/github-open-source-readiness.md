# GitHub source-release readiness

This checklist governs publication of the Phrio source repository. It does not
authorize a public macOS binary, an OpenAI request, a tag, or a GitHub Release.

## Current status

| Boundary | Current state |
| --- | --- |
| Product source of truth | protected public `main` |
| Public history root | `14dbf71b468c2b7ec3b156b34bae519df27881fa` |
| Internal history | offline bundle plus local-only `codex/internal-pre-public-main` |
| Remote | [`Dewensong/phrio-speech-coach`](https://github.com/Dewensong/phrio-speech-coach) |
| Source license | MIT |
| Public binary | none; current package remains ad hoc |
| Required CI check | `verify-macos-arm64`; first public-root run passed |

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

The 2026-07-24 audit and publication sequence found:

- no tracked `.env`, Apple certificate/key, real audio, SQLite database, model
  weight, DMG, ZIP, or other distributable;
- no current high-confidence credential after test values were changed to
  explicit non-production formats;
- native dependency install logs use project `loglevel=error`; `.npmrc` is
  itself checked to contain no registry, mirror, or authentication
  configuration;
- the largest internal historical blob was below 300 KiB, with no model or
  recording object found by path;
- public-facing current files were normalized to remove workstation-specific
  absolute paths;
- the old history contained a maintainer email address and older workstation
  paths, so it was preserved in a verified `0600` offline bundle and a
  local-only branch rather than pushed;
- the public `main` starts with one parentless commit using the maintainer's
  GitHub noreply address and the exact reviewed source tree;
- a temporary bare-repository push audit and the real GitHub clean clone each
  found only the public `main`; the temporary receiver had zero unreachable
  old objects.

A sanitized clean-source clone of
`6405179a9e55af2ff782dbf90bc7b8d3ff5d1e3d` passed locked installation, the
fixture-sentinel log check, and the complete production gate while reusing
reviewed local dependency caches and explicitly selecting the official Electron
Release source. Two isolated empty-HOME cold-cache attempts did not complete
the Electron download inside the bounded local window and were stopped. They
remain failed attempts rather than passes. After the GitHub Web merge identity
recovery described below, the recreated repository's GitHub-hosted Apple
Silicon run `30067263075` completed the locked install and full `pnpm verify`
on the final clean-history candidate.

## Completed remote sequence

1. Recorded and verified the complete internal-history bundle outside the repo.
2. Created a parentless public root with the identical source tree.
3. Simulated a main-only push into a temporary bare repository.
4. Created an empty private GitHub repository and pushed only public `main`.
5. Waited for `verify-macos-arm64` and compared its SHA with the intended root.
6. Cloned the private GitHub remote into a new empty directory and reran
   `pnpm verify:open-source`.
7. Changed visibility to public only after the remote CI and clean clone passed.
8. Enabled security controls and `main` protection before accepting changes.

The first public staging was returned to private when GitHub Web squash used a
profile contact email instead of the repository's noreply identity. That
repository remains a private audit archive; the original slug was recreated
empty, received only locally generated noreply commits, and repeated CI and
clean-clone verification before final publication. GitHub account email privacy
must be manually confirmed before any future Web merge.

The exact evidence, bundle digest, run ID, and evidence-level separation are in
[2026-07-24 GitHub source publication](../acceptance/2026-07-24-github-source-publication.md).

## GitHub repository settings

Current settings:

- protect `main`; block force-push and deletion;
- require pull requests, resolved conversations, and branches to be current;
- require the exact `verify-macos-arm64` status check;
- keep default workflow permissions read-only;
- enable dependency alerts, security updates, secret scanning, push
  protection, and Private Vulnerability Reporting where the account supports
  them;
- create the labels referenced by Issue templates, Dependabot, and release
  notes;
- create the `macos-release-candidate` Environment, restrict it to `main`, and
  require a maintainer reviewer;
- store Apple release credentials in that Environment only when a notarized
  candidate is actually in scope.

The initial Dependabot import exposed vulnerable transitive build-tool
dependencies. They were not dismissed: repository overrides now resolve
`tar 7.5.19`, `tmp 0.2.7`, and `fast-uri 3.1.4`. The official npm full and
production audits both report zero known vulnerabilities at the recorded
2026-07-24 checkpoint, and `pnpm verify` passes with the overridden toolchain.

The social preview source remains
`docs/assets/phrio-social-preview.png`; uploading it is a repository appearance
setting and does not change the evidence status of the controlled image.

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

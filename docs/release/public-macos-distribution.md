# Public macOS distribution

This document defines the release boundary for a shareable Phrio macOS build.
It does not authorize publication. The protected `main` branch in
[`Dewensong/phrio-speech-coach`](https://github.com/Dewensong/phrio-speech-coach)
is the public product source of truth, but there is still no public binary
release.

## Two deliberately separate lanes

| Lane | Trigger | Signature | Artifact meaning |
| --- | --- | --- | --- |
| Internal Alpha CI | pull request, selected branch push, or manual run | ad hoc | automated build evidence only |
| Public release candidate | manual workflow only | Developer ID + hardened runtime + Apple notarization | candidate that may be shared after human approval |

The public workflow has `contents: read` permission. It uploads a short-lived
workflow artifact but cannot create a GitHub Release, tag, or repository commit.

## Required Apple assets

The maintainer must obtain these from an Apple Developer account:

1. A `Developer ID Application` certificate and private key exported as a
   password-protected PKCS#12 file.
2. An App Store Connect API key (`.p8`) authorized to submit notarization jobs.
3. The matching API key ID and issuer ID.

Store the following values in the protected
`macos-release-candidate` GitHub Actions environment:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE_P12` | Base64-encoded PKCS#12 file |
| `APPLE_CERTIFICATE_PASSWORD` | PKCS#12 export password |
| `APPLE_SIGNING_IDENTITY` | Exact `Developer ID Application: … (TEAMID)` identity |
| `APPLE_API_KEY_P8` | Base64-encoded App Store Connect `.p8` file |
| `APPLE_API_KEY_ID` | App Store Connect API key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer UUID |

Never commit any of these values. Do not paste them into an issue, pull request,
diagnostic bundle, shell history, or acceptance document.

Require a maintainer reviewer for that environment and restrict deployment to
`main`. The workflow exposes raw certificate and API-key material only to the
steps that validate or import it. Dependency installation and `pnpm verify`
finish before any certificate is imported or `.p8` file is written.

## Candidate creation

1. Confirm the intended `main` commit and run the standard `Phrio CI` workflow.
2. Manually dispatch **Phrio public macOS release candidate**.
3. Enter an evidence label. The label changes only the workflow artifact name;
   it does not create a tag or change `package.json`.
4. Download the resulting DMG, ZIP, and `SHA256SUMS.txt`.
5. Perform the real-device acceptance below before deciding whether to publish.

The workflow:

- refuses to build a source ref other than `main`;
- validates the evidence label before reading credentials;
- rejects missing credentials before building;
- imports the certificate into a temporary keychain;
- runs `pnpm verify`;
- signs the app with hardened runtime and least-privilege entitlements;
- notarizes and staples the app;
- creates ZIP and DMG artifacts;
- notarizes and staples the DMG container;
- verifies Developer ID authority, Team ID, Gatekeeper acceptance, required
  microphone/JIT entitlements, absence of unrelated permission declarations,
  notarization tickets, and checksums;
- removes temporary signing material;
- uploads artifacts for 14 days without publishing them.

## Real-device acceptance after download

Use a target Mac that did not build the app:

1. Download the DMG and verify its SHA-256 value.
2. Open the DMG and drag Phrio to Applications.
3. Launch through Finder without bypassing Gatekeeper. Record whether macOS
   reports an identified developer and opens normally.
4. Start a real practice, grant microphone access once, quit, relaunch the same
   installed app, and confirm the permission persists.
5. Run partial/final, stop finalization, input interruption and recovery, local
   diagnosis, optional Drill, retry comparison, record management, and
   diagnostic export.
6. Measure model installation, first-ready latency, CPU, memory, and sustained
   practice behavior on the target hardware.
7. If OpenAI behavior is in scope, obtain independent approval immediately
   before sending transcript text. A successful local candidate build is not
   cloud consent.

Developer ID signing stabilizes the code-signing identity used by macOS TCC.
It should remove the ad-hoc build's changing-identity cause of repeated
microphone prompts, provided the bundle identifier, signing team, and installed
application identity remain stable. It does not prove the target Mac behavior;
step 4 is still required evidence.

## Human publication gate

A maintainer may create a GitHub tag or Release only after:

- the intended commit is established as the product repository truth;
- automated, controlled-fixture, and real-device evidence are reported
  separately;
- P0/P1 findings are closed or explicitly block release;
- the DMG and ZIP checksums match the workflow evidence;
- license, third-party notices, privacy language, and release notes are reviewed;
- publication is explicitly approved.

The candidate workflow must not merge branches, create tags, create a GitHub
Release, or publish artifacts. It only produces a short-lived candidate for the
separate human and real-device gates above.

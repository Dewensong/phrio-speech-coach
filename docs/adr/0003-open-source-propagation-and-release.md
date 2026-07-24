# ADR 0003: Open-source propagation and public release boundaries

- Status: Accepted
- Date: 2026-07-23
- Amended: 2026-07-24

## Context

Phrio had a complete Internal Alpha practice loop and strong evidence gates, but
the first encounter still required model installation and microphone permission.
That made the method expensive to understand, made screenshots hard to share,
and left a future open-source repository without a clear contribution or public
distribution boundary.

Propagation must not weaken the existing product rules:

- controlled fixture output cannot be presented as real-device evidence;
- no complete transcript, audio, key, or customer material should be made
  public by default;
- optional OpenAI calls retain purpose-specific consent;
- Phrio does not invent total scores, personality judgments, or winner/loser
  framing;
- the repository has no remote or primary branch yet, so infrastructure must
  not silently publish.

## Decision

### Controlled demo

Phrio includes a three-stage, 30-second controlled demo:

1. frozen final sentence and linked evidence;
2. one deterministic focus and short Drill;
3. same-criterion before/after comparison.

It requests no microphone permission, installs no model, creates no practice
record, and makes no cloud request. Every demo screen identifies the data as
controlled. Entering the demo before onboarding does not bypass the first-run
privacy acknowledgement.

### Result presentation and export

Completed records can generate local 16:10, 1:1, or 9:16 result cards as PNG,
SVG, or Markdown. The card contains the conclusion, one focus, success
condition, and optional comparison. A single evidence quote is opt-in and off by
default; the complete transcript is never exported by this feature. Phrio does
not create a public link or upload the card.

The same card can enter a keyboard-dismissible clean presentation mode. The
modal traps focus and returns focus to its trigger when closed.

### Community task packs

Open-source extension starts with task-only JSON packs for existing modes.
Packs are strict-schema validated and compiled into the app. They cannot execute
code, add a cloud provider, introduce a scoring system, or download runtime
plug-ins. New Sessions freeze the compiled task, rubric, focus and Drill graph,
so later repository edits cannot rewrite old records.

### Repository and license

Repository-authored source and assets use MIT. Community files must explicitly
declare MIT and contain original, non-private material. Runtime dependencies and
downloaded model files retain their own licenses; the packaged app carries
license texts and Electron's Chromium inventory.

### Two release lanes

Internal Alpha CI stays ad hoc and credential-free. A second workflow is manual
only, requires Apple Developer credentials, uses Developer ID and hardened
runtime, notarizes both app and DMG, verifies Gatekeeper and stapling, and
uploads only a short-lived candidate artifact. It has read-only repository
permission and cannot create a tag, GitHub Release, commit, merge, or
publication.

## Consequences

- People can understand and share Phrio's method before granting sensitive
  permissions.
- Shareable output is visually coherent while privacy remains conservative.
- Contributors have a low-risk entry point that does not open runtime plug-in
  execution.
- Developer ID distribution can stabilize the macOS signing identity that TCC
  uses for microphone permission, but the target-Mac relaunch check remains
  real-device evidence.
- A successful release workflow proves signing/notarization mechanics, not
  microphone behavior, local-model quality, performance, training outcomes, or
  consent for real OpenAI transcript transmission.
- Remote configuration, primary-branch creation and publication remain explicit
  maintainer decisions outside these workflows.

## 2026-07-24 source-truth and credential-scope amendment

The maintainer subsequently authorized local `main` at the accepted product
tip. The historical candidate branch remains as an equal-point rollback
reference; no merge commit was introduced and no remote was configured.

Repository CI now treats `main` as the only push source. The manual public
candidate workflow refuses non-`main` refs, uses the protected
`macos-release-candidate` environment, keeps checkout credentials disabled, and
exposes Apple credential values only to the steps that validate, import, sign,
or notarize. Dependency installation and `pnpm verify` complete before any
certificate or `.p8` material is written to the runner. This amendment changes
repository governance, not the recorder, ASR, cloud-consent, evidence,
persistence, or binary-publication boundaries.

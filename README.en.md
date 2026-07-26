<p align="center">
  <a href="docs/assets/phrio-launch-film.mp4?raw=1">
    <img src="docs/assets/phrio-launch-film-preview.gif" alt="Phrio launch film: inspect the words, choose one focus, and retry on the same criterion" width="840">
  </a>
</p>

<p align="center">
  <a href="docs/assets/phrio-launch-film.mp4?raw=1"><strong>▶ Play the 30-second film with sound (1080p)</strong></a>
</p>

<h1 align="center">Phrio</h1>

<p align="center">
  <strong>Speak once. Find one actionable focus. Say it again, more clearly.</strong>
</p>

<p align="center">
  A local-first desktop app for deliberate spoken-expression practice in Chinese.
  Phrio anchors feedback to your actual words, then compares the first and second
  attempts on one frozen criterion—without inventing a total score.
</p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="#30-second-launch-film">Launch film</a> ·
  <a href="#30-second-demo">30-second demo</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="SECURITY.md">Security</a>
</p>

<p align="center">
  <sub>macOS Apple Silicon · local-first · no account · MIT</sub>
</p>

<p align="center">
  <a href="https://github.com/Dewensong/phrio-speech-coach/actions/workflows/ci.yml">
    <img src="https://github.com/Dewensong/phrio-speech-coach/actions/workflows/ci.yml/badge.svg?branch=main" alt="Phrio CI">
  </a>
</p>

> [!IMPORTANT]
> Phrio is currently a macOS Apple Silicon Internal Alpha. The source, automated
> gates, and controlled fixtures are available, but a Developer ID–signed and
> notarized public binary has not been released yet.

## 30-second launch film

The silent preview above plays inline. Click the image or the
[play link](docs/assets/phrio-launch-film.mp4?raw=1) for the complete 1080p version
with sound. The public soundtrack and action cues are synthesized by project
scripts and do not use the internal reference mix. Product footage uses
controlled fixtures captured from the real packaged UI; it demonstrates the
method, not real-device or training-outcome evidence.

## Practice the sentence, not a speaking score

Most speaking tools either return a generic score or rewrite the answer for you.
Phrio treats clearer expression as a short editorial rehearsal:

| Evidence, not vibes | One focus, not a report | A fair retry, not a vanity score |
| --- | --- | --- |
| Feedback points back to the finalized words that triggered it. | You choose one actionable criterion—or stop after diagnosis. | The second attempt is compared only on that frozen criterion. |

That creates one compact loop the learner still controls:

1. **Speak** using a real microphone and local streaming ASR.
2. **Inspect evidence** linked to the exact finalized sentence.
3. **Choose one focus** and complete a short Drill—or stop after diagnosis.
4. **Retry the same task** and compare only the frozen criterion.
5. **Save or share a privacy-safe result card** generated locally.

No account or cloud service is required for the local practice loop. Optional
OpenAI features remain off until the user configures a key and grants the
matching purpose-specific consent.

<p align="center">
  <img src="docs/assets/phrio-hero.png" alt="The real packaged Phrio controlled tour showing a same-criterion comparison" width="960">
</p>

<p align="center">
  <sub>Real packaged UI, controlled tour data. No microphone, model download, record creation, or cloud call.</sub>
</p>

## 30-second demo

The built-in controlled demo shows the complete method without requesting
microphone permission, downloading the local ASR model, creating a practice
record, or calling a cloud provider.

<p align="center">
  <img src="docs/assets/phrio-demo.gif" alt="Controlled Phrio demo: evidence, one focus, and same-criterion comparison" width="840">
</p>

The demo is permanently labelled as controlled data. It is a product tour, not
evidence of real microphone, model, or cloud-provider quality.

## What is implemented

- Local microphone capture, device selection, input-health feedback, playback,
  retry, and deletion.
- Local Sherpa-ONNX streaming ASR with partial/final separation, recovery paths,
  frozen timestamps, and a resumable model installer.
- Evidence-linked local diagnosis, one optional focus, short Drill, retry, and
  same-criterion comparison.
- Dual record views: current diagnosis and the frozen live-evidence ledger.
- Local PNG/SVG/Markdown result cards in 16:10, 1:1, and 9:16 formats. Evidence
  quotes are opt-in; complete transcripts are never added to result cards.
- Light/dark/system themes, constrained palettes, text scaling, reduced motion,
  keyboard focus recovery, and compact 1024 px layouts.
- Optional OpenAI live hints, deep diagnosis, and semantic comparison behind
  separate consent boundaries.
- Repository-owned community task packs validated at build time; no downloaded
  code or runtime plug-in execution.

## Privacy model

| Data | Default location | Cloud boundary |
| --- | --- | --- |
| Audio and PCM | Local device | Never included in AI payloads |
| Partial transcript | In-memory live state | Never persisted or uploaded |
| Final transcript and practice records | Local SQLite | Sent only for an explicitly enabled and approved AI purpose |
| Share cards | Generated locally on user action | No public link is created |
| Diagnostics | Local rotating logs | Exported only to a user-selected file |

The app has no telemetry or account requirement. See the
[Chinese homepage](README.md), the detailed
[Chinese Internal Alpha documentation](docs/internal-alpha.zh-CN.md), and the
[security policy](SECURITY.md) for the full boundary.

## Quick start

Requirements:

- macOS on Apple Silicon
- Node.js `24.18.0` or newer
- pnpm `10.33.2`

```bash
pnpm install --frozen-lockfile
pnpm start
```

For a no-permission product tour, choose **30 秒受控演示** on the first screen.
For real practice, install the approximately 226.2 MiB pinned local model when
prompted, then grant microphone access when recording begins.

Run the production gate:

```bash
pnpm verify
```

Run the real Electron visual and controlled product tours:

```bash
pnpm verify:electron-visual
pnpm verify:electron-product-tour
```

## Download and distribution

The [source repository](https://github.com/Dewensong/phrio-speech-coach) is
public. There is no public binary release yet. The current CI produces
short-lived, explicitly ad-hoc Internal Alpha evidence bundles. They are not
notarized public installers.

The repository now contains:

- a real Phrio icon and macOS DMG maker;
- environment-gated Developer ID signing and notarization;
- a manual release-candidate workflow that refuses to run without Apple
  credentials;
- separate ad-hoc and public-distribution verification boundaries.

The maintainer must still provide an Apple Developer identity, notarization
credentials, and explicit publication approval. See
[Public macOS distribution](docs/release/public-macos-distribution.md).
The separate [GitHub source-release checklist](docs/release/github-open-source-readiness.md)
defines repository privacy, protection, CI, and clean-clone gates; completing
that checklist does not publish a binary.

## Community task packs

Phrio currently accepts task-only community packs for the existing Clear
Expression, Decision & Alignment, and Argument & Rebuttal modes. Packs are
reviewed JSON files compiled into the app and licensed under MIT.

Start with [`task-packs/contributions/product-review.json`](task-packs/contributions/product-review.json)
and read the [task-pack contribution guide](task-packs/README.md).

## Repository map

```text
src/
├── frontend/      # Pages, components, hooks, renderer services
├── backend/       # IPC controllers, services, SQLite/file repositories
├── preload/       # Narrow typed desktop bridge
└── shared/        # Schemas, state machines, frozen protocols

task-packs/        # Build-time validated community practice tasks
docs/              # ADRs, acceptance evidence, release and brand guidance
build/             # Entitlements and deterministic brand assets
```

## Evidence levels

Phrio intentionally separates:

- **Automated evidence** — unit, integration, packaging, security, and layout
  gates.
- **Controlled fixture evidence** — real Electron/IPC/SQLite flows using clearly
  labelled synthetic data.
- **Real-device evidence** — real microphone, local model, interruption,
  performance, and explicitly authorized cloud calls.

One category never substitutes for another. Current acceptance evidence lives
under [`docs/acceptance`](docs/acceptance). The current-tree secret, license,
workflow-permission, `main`, CI, and remote-boundary result is documented in
[`2026-07-24 GitHub source publication`](docs/acceptance/2026-07-24-github-source-publication.md).
The preceding local-only audit remains in
[`2026-07-24 GitHub open-source preflight`](docs/acceptance/2026-07-24-github-open-source-preflight.md).
The final full-product theme,
90–125% scale, keyboard, controlled-fixture, real-device-boundary, and source-truth
matrix is documented in
[`2026-07-24 Editorial rehearsal final acceptance`](docs/acceptance/2026-07-24-editorial-rehearsal-final-acceptance.md);
the local archive, device
ledgers, controlled specimen, result proof, and repository assets are documented in
[`2026-07-24 Records and propagation proof`](docs/acceptance/2026-07-24-editorial-rehearsal-records-propagation.md);
the transcript proof,
diagnosis, Drill, retry docket, and paired folio gates are documented in
[`2026-07-24 Editorial rehearsal training loop`](docs/acceptance/2026-07-24-editorial-rehearsal-training-loop.md);
the focused live workspace, evidence view, and capture details remain in
[`2026-07-24 Editorial rehearsal live workspace`](docs/acceptance/2026-07-24-editorial-rehearsal-live-workspace.md);
the preceding visual foundation remains in
[`2026-07-24 Editorial rehearsal foundation`](docs/acceptance/2026-07-24-editorial-rehearsal-foundation.md).
The preceding propagation, packaging, real-microphone stop closure, and
release-readiness evidence remains in
[`2026-07-23 Open-source propagation and release readiness`](docs/acceptance/2026-07-23-open-source-propagation-release-readiness.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Good first
contributions include practice tasks, accessibility improvements, deterministic
UI tests, documentation, and platform investigations that preserve the privacy
and evidence model.

Never commit real recordings, transcripts, customer material, API keys,
notarization credentials, or generated model weights.

## License

Phrio source code and repository-authored assets are available under the
[MIT License](LICENSE). Third-party dependencies and model files retain their
own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md). The Sherpa
model weights are downloaded separately and are not included in this repository.

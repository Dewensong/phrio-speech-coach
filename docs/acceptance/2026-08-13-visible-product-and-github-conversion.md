# Phrio Visible Product and GitHub Conversion Acceptance

Date: 2026-08-13

Verified public `main` base: `a5b9ac447c5a16b108219fc3d3278c5db71793dc`

Change branch: `codex/user-visible-momentum`

## Scope

This acceptance covers two user-visible product improvements and the public
GitHub repository conversion surface. It does not publish a macOS binary,
change microphone or OpenAI consent behavior, or add evidence for real-device
recognition quality, training outcomes, Developer ID signing, or notarization.

## Point-in-time GitHub baseline

The public repository check found:

- 0 Stars, 0 Forks, and 0 Watchers;
- 0 views and 0 unique visitors in the available 14-day traffic window;
- 25 clones from 13 unique cloners in the available 14-day traffic window;
- a 100% GitHub Community Profile;
- an existing bilingual README, public launch film, social preview, CI,
  contribution guide, security policy, issue templates, and protected `main`.

This supports a narrow product decision: improve visitor comprehension and the
first useful action before adding more repository machinery. Traffic metrics
are a point-in-time GitHub observation, not a durable product-performance claim.

## User-visible improvement 1: scenario starters

The free-practice home now offers three one-click scenario starters:

1. explain a complex idea;
2. move a decision forward;
3. review a miss or failure.

Each starter fills the topic, audience, and goal fields. It does not create a
Session, request microphone permission, or begin recording. The learner can
edit every field before explicitly selecting **直接开始**.

Acceptance conditions:

- all three starters are visible and keyboard-accessible;
- selecting a starter fills one concrete topic, audience, and goal;
- selecting a starter creates no local practice record;
- the existing free-practice start action receives the edited values;
- 1440×960, 1024×960, and 1024×960 at 125% text remain actionable and have no
  horizontal overflow.

## User-visible improvement 2: factual local practice trail

The full history page now summarizes four locally derived facts:

- saved sessions;
- sessions with an initial and retry attempt;
- sessions with an explicitly chosen focus;
- sessions retaining local audio.

The view deliberately excludes scores, streaks, rank, ability labels, and
claims that more sessions imply better speech. Existing search, mode filters,
record details, rename, pin, and delete actions remain available.

Acceptance conditions:

- counts derive only from the already loaded local history items;
- an empty archive shows zeroes without inventing progress;
- a controlled record updates the session count while leaving unrelated facts
  at zero;
- standard and 1024 px layouts preserve record-management actions and have no
  horizontal overflow.

## GitHub conversion surface

Chinese remains the default homepage and English remains a complete parallel
version. Both now use the same order and boundaries:

1. concise value proposition;
2. lightweight static social preview;
3. launch film, source run, and Star actions;
4. Internal Alpha / no notarized public binary warning;
5. launch film and controlled-fixture boundary;
6. method, implemented capability, privacy, quick start, and distribution;
7. Now / Next / Later roadmap and contribution entry.

The Star request is explicitly non-transactional: it does not unlock features
and is not presented as proof of users or outcomes. The README does not claim a
public installer because the maintainer has not joined the Apple Developer
Program.

## Evidence classification

### Automated evidence

- TypeScript and focused frontend/API contract tests cover the two additions.
- The complete `pnpm verify` gate passed: the open-source gate inspected 269
  tracked files; 59 test files and 598 tests passed, with 1 file and 1 test
  explicitly skipped.
- Electron system-network and power-save-blocker probes, macOS arm64 packaging,
  18 packaged signing targets, the 40-method preload bridge, and the Sherpa
  `1.13.4` dependency smoke all passed.
- Electron visual verification passed 85/85 assertions with 9 screenshots.
- The combined Electron product and controlled-QA tour passed 152/152
  assertions with 49 screenshots, 13 product steps, and 6 QA steps.

### Controlled Fixture evidence

- The packaged product tour uses an isolated user-data directory, real
  Electron, the real preload bridge, IPC, and SQLite.
- Product-lane assertions cover all three starters, no premature Session, the
  factual trail, no score copy, compact layouts, console output, and external
  network requests.
- The separate QA lane uses controlled audio/transcript fixtures and does not
  claim a real microphone or installed model.
- The full tour recorded no renderer errors, no renderer warnings, and no
  external HTTP(S) requests in the product lane.

### Real-device evidence

- No new real-device evidence was created in this change.
- No microphone permission was requested, no real local model was installed or
  evaluated, no OpenAI key was provided, and no transcript was sent.
- Existing historical microphone evidence remains independent. Public binary
  distribution still requires Apple Developer membership, Developer ID,
  notarization, and target-Mac acceptance.

## Growth boundary

Repository presentation can improve conversion after a visitor arrives; it
cannot guarantee rapid Star growth. Ethical growth still requires a separate,
maintainer-approved distribution action with the public film, a clear audience,
and one repository link. Buying Stars, reciprocal-star schemes, fake accounts,
and fabricated outcome claims are outside the project boundary.

# Phrio GitHub Launch Film Publication

Date: 2026-07-26

Product source: `8dfdbf06ff3e8ac87966fe93a2b28be344bc3240`

Publication branch: `codex/publish-phrio-g4-film`

Pull request: [#10](https://github.com/Dewensong/phrio-speech-coach/pull/10)

Published commit: `d0eaa17076db9c8607ea864ee77a8b3d9b37bb7e`

## Scope

This acceptance closes only the public GitHub launch-film surface. It does not
publish a macOS binary, change product behavior, approve Developer ID signing,
or add evidence for real microphone, local-model quality, OpenAI output, or
target-Mac performance.

## Public assets

| Asset | Role | Media facts | SHA-256 |
|---|---|---|---|
| `docs/assets/phrio-launch-film-preview.gif` | Silent auto-playing README preview | 640×360, 8 fps, 30.01 s, 6,244,903 bytes | `12fbbf40144aa0c626753280525562902629a90e2cc050b7e7d87cb667a1347c` |
| `docs/assets/phrio-launch-film.mp4` | Click-to-play film | H.264, 1920×1080, 30 fps, BT.709 TV range; AAC 48 kHz stereo; 30.10 s; 8,493,207 bytes | `aecb4a8e132ecbaa26d38fde365d2348ee7e7abe00498b566edc47079f55498d` |
| `docs/assets/phrio-launch-film-cover.png` | Static poster / fallback propagation asset | PNG, 1920×1080, 146,180 bytes | `49fb112eac145aba9f28d15b84139740ce8d6d1aab051260039337dc687a44c3` |

The default Chinese `README.md` and `README.en.md` use the same silent preview,
the same 1080p play target, and equivalent product/evidence boundaries.

## Audio and rights boundary

- The public composition does not load the G3
  `reference-mix-internal.wav` asset.
- The soundtrack bed and sixteen action cues are generated locally by the
  Product Motion Studio FFmpeg script from noise and sine sources.
- The public files contain no reference-video audio, real user speech,
  transcript, model output, customer data, or portrait.
- The film remains labelled `Internal Alpha` and does not claim a downloadable
  notarized release.

## Evidence classification

### Automated media evidence

- Product Motion Studio TypeScript passed.
- The formal MP4, GitHub MP4, silent MP4, and README GIF decoded end to end.
- The GitHub MP4 is H.264/AAC and below 10 MB; the README GIF is below 10 MB.
- The formal 1080p mix measured `-15.82 LUFS / -1.20 dBTP`.
- Black-frame detection had no hits; the f0600 deterministic still hash matched
  across two renders.
- A 15-frame contact sheet and ten keyframes covered the complete visual arc.

### Controlled Fixture evidence

- Product UI footage comes from the real packaged Electron application using
  the repository's controlled 30-second Fixture.
- The underlying capture requested no microphone, installed no model, created
  no practice record, and made no cloud call.
- These screens demonstrate the product method and real UI implementation; they
  do not prove recognition quality or training outcomes.

### Real-device evidence

- No new real-device evidence was created for this publication.
- Earlier microphone/model evidence remains independently documented and is not
  presented as film-production proof.

## GitHub publication result

- Main remains protected by required `verify-macos-arm64` status checks and PR
  review flow.
- PR #10 passed `verify-macos-arm64` and was squash-merged through branch
  protection on 2026-07-26. The resulting public commit and its GitHub
  committer identity both use noreply addresses.
- The Chinese and English README, preview GIF, poster, and MP4 are present on
  public `main`; the raw GIF and MP4 endpoints returned HTTP 200 after merge.
- Publishing these README assets does not create a GitHub Release, tag, public
  installer, or Apple publication approval.

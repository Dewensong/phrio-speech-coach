# Phrio brand and propagation assets

## Source assets

- `build/brand/phrio-icon.svg` is the editable vector source for the application
  mark.
- The macOS icon uses a transparent outer canvas and a flat editorial
  print language. A continuous `P` path stands for one spoken attempt; the
  offset sea-green pass stands for saying it again; the single vermilion point
  is the one frozen focus. There are no glass highlights, AI glows, microphone
  clichés, or decorative waveforms.
- `build/brand/Phrio.icns` is the macOS package icon.
- `build/brand/dmg-background.svg` is the editable installer background source;
  `dmg-background.png` is the raster used by Forge.
- `docs/assets/phrio-social-preview.png` is the lead README artwork and the
  1280×640 image intended for GitHub repository social preview settings.
- `docs/assets/phrio-hero.png` is the full-width packaged-product proof shown
  beneath the README's core product claim.
- `docs/assets/phrio-demo.gif` is the three-stage controlled-demo loop.

The mark is code-native so the application icon, in-product brand, SVG result
card, and repository assets can use the same construction and visual language
without a generative-image dependency.

The installer, repository preview, and exported result cards deliberately use
the same flat paper-and-ink system: hard edges, offset registration, editorial
rules, and one vermilion focus. They do not use translucent glass panels,
blurred glow fields, or decorative gradients.

The current controlled specimen, result-proof layout, generated checksums, and
zero-permission / zero-persistence capture evidence are recorded in
[`2026-07-24 local archive and propagation proof`](../acceptance/2026-07-24-editorial-rehearsal-records-propagation.md).

Regenerate the tracked `.png`, `.icns`, and DMG raster after editing either SVG:

```bash
pnpm build:brand-assets
```

## Evidence boundary

The README images come from the real packaged Electron application, but their
content is the built-in controlled demo. They prove that the packaged UI can
render the demo without external requests or persistence; they do not prove
microphone, local-model, OpenAI, performance, or training quality.

Regenerate them only after a production package is available:

```bash
pnpm capture:propagation-assets
```

The capture script uses isolated blank `userData`, checks that no Session was
created and no external HTTP(S) request occurred, and writes a checksum report
to `output/propagation-assets/report.json`. ImageMagick's `magick` command is
required to assemble the GIF.

## GitHub use

After a remote repository exists, upload
`docs/assets/phrio-social-preview.png` through GitHub's repository settings.
That is a manual repository-administration action; this project does not attempt
to configure it through CI.

Do not present the controlled demo as a customer recording or real-device
result. Do not place private transcript text in marketing screenshots.

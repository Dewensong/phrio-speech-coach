# Third-party notices

Phrio is built with third-party software. Those components remain governed by
their own licenses; the Phrio MIT license does not replace them.

## Runtime components

| Component | Version used by this revision | License | Project |
| --- | --- | --- | --- |
| Electron | 43.1.1 | MIT; bundled Chromium notices | <https://www.electronjs.org/> |
| React / React DOM / Scheduler | 19.2.7 / 19.2.7 / transitive | MIT | <https://react.dev/> |
| Lucide React | 1.24.0 | ISC | <https://lucide.dev/> |
| Zod | 4.4.3 | MIT | <https://zod.dev/> |
| sherpa-onnx-node / darwin-arm64 runtime | 1.13.3 / 1.13.4 | Apache-2.0 | <https://github.com/k2-fsa/sherpa-onnx> |

The packaged macOS application includes the corresponding license texts and
Electron's generated Chromium license inventory under
`Phrio.app/Contents/Resources/licenses/`.

## Downloaded ASR model

Phrio does not redistribute model weights in this repository or application
bundle. When the user starts model installation, Phrio downloads the pinned
`csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en` files from the
frozen distribution identity. The model repository declares Apache-2.0:

<https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en>

The model card states that its ONNX files were converted from a ModelScope
Paraformer model. Maintainers must re-check upstream model provenance and
license metadata before each public binary release; this notice records the
current repository metadata and is not independent legal advice.

## Complete dependency graph

Exact JavaScript package versions are frozen in `pnpm-lock.yaml`. Development
and packaging tools are not necessarily shipped in the application. Before a
public release, review the packaged runtime contents and generated license
inventory again rather than treating this file as a permanent exhaustive list.

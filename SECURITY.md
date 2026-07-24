# Security policy

## Supported versions

Phrio is currently an Internal Alpha. Only the latest source revision and the
latest explicitly identified release candidate receive security fixes.

## Reporting a vulnerability

Do not open a public issue containing secrets, transcripts, recordings,
personal data, exploit details, or a working proof of concept.

When this repository is public, use GitHub Private Vulnerability Reporting if it
is enabled. Until then, report the issue to the maintainer through the same
private channel used to receive the source or Internal Alpha package.

Include:

- affected revision and platform;
- the smallest reproducible sequence;
- expected and observed trust boundary;
- whether audio, transcript text, credentials, local files, IPC, or network
  access may be exposed;
- a redacted diagnostic ID when available.

Phrio diagnostics intentionally exclude raw audio, complete transcript text,
API keys, authorization headers, and AI request/response bodies.

## Security boundaries

- The renderer is sandboxed with context isolation and no Node integration.
- IPC validates sender, input, and output schemas.
- Audio and PCM are local by default and never enter AI payloads.
- Optional AI purposes have independent consent.
- API keys remain in the main process and must never be placed in issues or
  diagnostics.
- Public macOS packages must be Developer ID signed, hardened, and notarized.

Security reports are acknowledged privately. Disclosure timing depends on
reproducibility, severity, and availability of a verified fix.

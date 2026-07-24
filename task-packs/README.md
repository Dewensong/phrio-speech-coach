# Phrio community task packs

Community task packs add reviewable practice prompts to the three existing Phrio
mode systems. They are compiled with the application and validated at build time;
Phrio does not load arbitrary runtime code or remote task packs.

## Add a pack

1. Copy `contributions/product-review.json`.
2. Give the pack and every task a lowercase, stable identifier.
3. Choose one existing `modeId`.
4. Use criterion identifiers already defined for that mode in
   `src/shared/mode-packs.ts`.
5. Keep the contribution under the MIT license and do not include personal,
   customer, confidential, or copyrighted source material.
6. Run `pnpm typecheck && pnpm test`.

Task IDs are namespaced at build time as `community.<pack-id>.<task-id>`. The
complete task, current rubric, and Drill definitions are still frozen into every
new Session, so later pack edits cannot rewrite old practice records.

The current format intentionally extends tasks only. New modes, scoring systems,
cloud providers, or runtime-downloaded code require a separate architecture and
privacy review.

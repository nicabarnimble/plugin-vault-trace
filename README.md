# Trace

Trace is an Obsidian community plugin for append-only, tamper-evident Markdown logs. It gives a vault a verifiable timeline of “what happened when” that humans can read and external tools can parse without Obsidian installed.

Trace is **not** event sourcing. Do not reconstruct application state from the log. Trace records evidence: timestamped entries, stable anchor hashes, writer identity, and optional attestations for vault file content.

## Quick example

A Trace file is plain Markdown:

```md
---
trace: true
format: tracev1
trace_name: Project log
trace_slug: project-log
actor_name: Laptop
actor_slug: laptop
actor_id: 7f2a...
---
- 1 | 2026-07-08T10:00:00Z | Laptop | #genesis | Trace "Project log" started by Laptop | #1234abcd
- 2 | 2026-07-08T10:05:00Z | Laptop | #decision | Use one chain per writer | #a1b2c3d4
```

Each entry commits to the previous entry with SHA-256. If someone edits, deletes, inserts, or reorders committed entries, verification pinpoints the break.

## What this plugin does

Inside Obsidian, Trace provides:

- **Create timeline** — creates this device’s writer file with frontmatter and a genesis entry.
- **Append entry** — appends a new timestamped entry with an optional tag.
- **Record file change** — appends a `#attest` entry for the active file’s current SHA-256.
- **Verify integrity** — verifies the active trace file’s sequence and hash chain.
- **Verify all** — verifies all known trace files and reports trace-level issues.
- **Re-baseline file** — explicitly accepts a broken own file as a new trusted baseline and appends `#rebaseline`.
- Editor protection — existing entries are read-only; own files allow append-only tails; other writers’ files are fully read-only.

Outside Obsidian, Trace provides:

- [`FORMAT.md`](FORMAT.md), the normative `tracev1` file format.
- [`reference/parser.ts`](reference/parser.ts), a standalone TypeScript parser/verifier with no Obsidian imports.
- Stable short anchors like `#a1b2c3d4` that external systems can cite and later verify.
- `appendEntry`, `headOf`, `verifyProgression`, `mergeTimelines`, and attestation helpers for scripts and agents.

## Mental model

A **trace** is a logical timeline, such as “Project log”.

A **writer** or **actor** is one device, human environment, script, or agent that writes entries.

A **writer file** is the physical Markdown segment for one actor in one trace:

```text
Traces/<trace-slug>/<segment>-<start-month>.<actor-slug>.md
```

Example:

```text
Traces/project-log/0001-2026-07.laptop.md
```

A **segment** is one physical file in that actor’s chain history. Trace starts a new segment automatically when the current file gets too large or too old. Legacy flat files like `Traces/project-log.laptop.md` are still supported.

A **chain** is the per-file sequence of entries and hashes. Sequence numbers are total order within one writer file segment.

A **merged timeline** combines writer files for the same logical trace by timestamp. This cross-writer order is approximate because device clocks can drift.

An **anchor** is the stored short hash at the end of an entry. External tools can say “as of entry `#a1b2c3d4`” and later verify that the prefix up to that entry still matches.

A **trusted head** is the full `{seq, hash}` stored outside a writer’s control. Supervisors use it to detect a writer rewriting and recomputing its own chain.

## Why one file per writer?

Obsidian Sync can auto-merge concurrent Markdown edits. If multiple devices wrote the same trace file, normal sync behavior could splice competing edits into one file and fork the hash chain.

Trace avoids this by making each actor write only its own active file segment:

```text
Traces/project-log/0001-2026-07.laptop.md
Traces/project-log/0001-2026-07.phone.md
Traces/project-log/0001-2026-07.agent-a.md
```

Each file segment has independent sequence numbers and a separate hash chain. Verification remains meaningful even when multiple devices or agents contribute to the same logical timeline.

Single-file multi-writer traces are intentionally out of scope.

## Threat model

A vault is plain Markdown on disk. True immutability is impossible from an Obsidian plugin. Trace never claims immutability.

Trace protects against accidental edits and makes many outside changes detectable:

- Editing a committed entry breaks the hash chain.
- Deleting or inserting a middle entry creates a sequence gap or duplicate and a hash mismatch.
- Removing entries from the end is detected by the plugin’s recorded trusted head state.
- Inside Obsidian, old entries in your own files are blocked or reverted according to settings.
- Files owned by another writer are read-only on this device and are never auto-reverted here.

Trace does not protect against everything:

- A writer with full file access can rewrite its own file and recompute all later anchors.
- To trust a trace against its own writer, a supervisor must store the last-seen full head outside that writer’s reach and call `verifyProgression` on each read.
- Cross-writer ordering is approximate under clock skew.
- Trace does not encrypt entries or hide vault content.
- Trace does not automatically log every vault modification in v1.

## First-time setup for Obsidian users

1. Install or copy the plugin into your vault’s plugins folder.
2. Enable **Trace** in Obsidian settings.
3. Run **Create timeline** from the command palette.
4. Run **Append entry** from the command palette or ribbon.
5. Run **Verify integrity** on the active trace file when you want to check it.

Trace creates an automatic device name on first use, such as `Device 7f2a9c10`. You can rename it in settings later; existing owned files continue to receive appends, and new writer files use the new name.

Device identity is stored in Obsidian local storage with `app.loadLocalStorage` and `app.saveLocalStorage`. It is never written to synced plugin `data.json`, because synced identity would make every device claim the same writer.

If local identity is missing but trace files already exist, Trace asks whether to reclaim an existing actor or create a new automatic identity. It does not silently mint a new identity in that situation.

## Settings

- **Traces folder** — folder where new writer files are created. Default: `Traces`.
- **Additional trace paths** — specific files outside the folder to treat as traces.
- **Detect traces by frontmatter** — treat files with `trace: true` as trace files.
- **This device’s name** — friendly actor name for entries from this device.
- **Enforcement mode** — `enforce` reverts non-append changes to own files; `warn` only notifies.
- **Read-only guard** — CodeMirror protection for committed entries.
- **Rotation** — `auto` starts a new file segment when the active writer file reaches the size or age limit; `never` keeps one file per writer.
- **Max segment size** — auto-rotation size limit. Default: 1 megabyte.
- **Max segment age** — auto-rotation age limit. Default: 365 days.
- **Display template** — reading-view decoration using `{{seq}}`, `{{timestamp}}`, `{{actor}}`, `{{tag}}`, `{{text}}`, `{{hash}}`.
- **Tags** — user tag vocabulary offered by the append modal.

Reserved protocol tags are `#genesis`, `#rebaseline`, `#attest`, and `#rotate`. User tags cannot redefine them.

## Entry format and verification

The exact grammar, escaping rules, canonical serialization, genesis constant, chain construction, and re-baseline semantics are defined in [`FORMAT.md`](FORMAT.md). That document is the source of truth for external implementers.

At a high level, each entry stores:

1. sequence number,
2. UTC timestamp,
3. actor name,
4. optional tag,
5. escaped text,
6. short hash anchor.

The hash input is the previous full hash plus the canonical entry serialization. The stored anchor is the first 8 lowercase hex characters of the full SHA-256. Verifiers recompute the full chain from the start of the file.

## File size and rotation

Trace uses segmented file names by default:

```text
Traces/<trace-slug>/<segment>-<start-month>.<actor-slug>.md
```

The default rotation policy is **auto**:

- rotate when the active writer file reaches 1 megabyte, or
- rotate when the active writer file is 365 days old.

Light users may keep one segment for a year. High-volume agents may rotate many times in the same month. Rotating does not delete history; it creates a new segment whose first entry is `#rotate` and points to the previous segment’s path, sequence, and full head hash.

Retention is separate from rotation. Trace keeps old segments forever by default.

## Attestations for vault files

Trace supports a `#attest` convention for entries that attest to vault file content. The entry grammar is unchanged; structured data lives in the existing text field:

```text
path=Projects/plan.md change=modify sha256=<64 lowercase hex>
```

Supported changes are `create`, `modify`, `delete`, and `rename`. Rename uses `from=<old-path> to=<new-path> change=rename sha256=<hash-after-rename>`.

An external system verifies a reference to a vault file by finding the latest `#attest` for that path in the merged timeline, hashing the current file bytes, and comparing to the attested `sha256`.

- Match: the reference is current.
- Mismatch with a newer attestation: follow the timeline.
- Mismatch with no newer attestation: the file changed without attestation. That is an undocumented-change signal, not a trace-format error.

No automatic vault-wide change logging is included in v1. Humans can use **Record file change** for the active file; agents and scripts can write their own `#attest` entries. Auto-attesting every vault modify event would flood timelines and double-log sync deliveries across devices.

## External tools and agents

Use [`reference/parser.ts`](reference/parser.ts) for non-Obsidian integrations. Do not import plugin UI modules under `src/` from external tools.

The reference module exports:

- `parseTrace(text)` — parse frontmatter and entry lines.
- `verifyTrace(text)` — verify grammar, sequence continuity, and hash chain.
- `appendEntry(text, entry)` — append one canonical entry to an existing valid actor file.
- `headOf(text)` — return the verified current full `{seq, hash}` head.
- `verifyProgression(oldHead, text)` — prove the old head is still an ancestor and all later entries are valid appends.
- `mergeTimelines(files)` — merge multiple writer files by timestamp while preserving per-writer sequence order.
- `formatAttestationPayload(payload)` and `parseAttestationPayload(text)` — handle `#attest` payloads.
- `sha256Bytes(bytes)` and `sha256Hex(text)` — compute hashes in the same runtime model.

Agent pattern:

1. Give each agent its own actor file.
2. The agent appends work entries to only that file.
3. The agent writes `#attest` entries for files it changed.
4. A supervisor stores each agent’s full head outside the vault.
5. On each read, the supervisor calls `verifyProgression` before trusting new entries.
6. The supervisor merges verified actor timelines for review.

This is the key trust rule: a hash chain alone cannot protect a trace from its own writer. A stored external head can.

## External consumer quickstart

The reference parser has no Obsidian imports and uses Web Crypto. This Node 20+ example can be run after compiling `reference/parser.ts`, or directly with a TypeScript runner such as `tsx`.

```ts
import { readFile, writeFile } from "node:fs/promises";
import {
  appendEntry,
  formatAttestationPayload,
  headOf,
  mergeTimelines,
  sha256Bytes,
  verifyProgression,
  verifyTrace,
} from "./reference/parser.ts";

const text = await readFile("Traces/project-log/0001-2026-07.agent-a.md", "utf8");
const result = await verifyTrace(text);
if (!result.ok) throw new Error(result.issues[0]?.message ?? "Invalid trace");

const oldHead = await headOf(text);
if (!oldHead) throw new Error("Missing verified head");

const nextText = await appendEntry(text, {
  actor: "agent-a",
  tag: "#agent",
  text: "Completed nightly export",
});

const bytes = await readFile("Projects/plan.md");
const attestation = formatAttestationPayload({
  change: "modify",
  path: "Projects/plan.md",
  sha256: await sha256Bytes(bytes),
});

const attestedText = await appendEntry(nextText, {
  actor: "agent-a",
  tag: "#attest",
  text: attestation,
});
await writeFile("Traces/project-log/0001-2026-07.agent-a.md", attestedText);

const progression = await verifyProgression(oldHead, attestedText);
if (!progression.ok) throw new Error(progression.status);

const merged = mergeTimelines([
  { actor: "agent-a", text: attestedText },
  { actor: "human-laptop", text: await readFile("Traces/project-log/0001-2026-07.laptop.md", "utf8") },
]);
console.log(merged.timeline.map((item) => `${item.entry.timestamp} ${item.actor} ${item.anchor}`));
```

External writers must be the sole writer of their actor file, just like Obsidian devices. `appendEntry` appends to an existing valid actor file; creating the initial file requires frontmatter and a genesis entry as described in [`FORMAT.md`](FORMAT.md).

## Repository map for contributors and agents

- `FORMAT.md` — normative protocol documentation. Read this before changing parser or writer behavior.
- `reference/parser.ts` — standalone parser, verifier, external append path, progression checks, and timeline merge.
- `src/format.ts` — plugin-side format helpers; re-exports reference parser logic to avoid protocol drift.
- `src/hashchain.ts` — plugin write path, append serialization, trusted head state.
- `src/guard.ts` — append-only enforcement and CodeMirror read-only guard.
- `src/identity.ts` — per-device actor identity and reclaim flow.
- `src/appendModal.ts` — create, append, and record-file-change modals.
- `src/verify.ts` — verify commands, reports, and re-baseline logic.
- `src/settings.ts` — settings tab and validation.
- `src/main.ts` — plugin lifecycle, registry, commands, events, and Markdown post-processing.
- `tests/` — parser, guard/helper, and writer byte-identity tests.
- `docs/community-listing.md` and `docs/screenshots/` — listing copy and placeholder assets.

Protocol-changing work should start with `FORMAT.md`, then `reference/parser.ts`, then plugin code and tests. The protocol defines the plugin, not the other way around.

## Development

```bash
npm ci
npm run dev
npm run lint
npm test
npm run build
```

Scripts:

- `npm run dev` — esbuild watch mode.
- `npm run build` — TypeScript check plus production bundle to `main.js`.
- `npm run lint` — ESLint with Obsidian community-plugin rules.
- `npm test` — Vitest test suite.
- `npm run version` — update `manifest.json` and `versions.json` for a release.

Release tags must be exact versions with no `v` prefix, matching `manifest.json`, `package.json`, and `versions.json`. The release workflow attaches `main.js`, `manifest.json`, and `styles.css`.

## FAQ

### Does Trace make logs immutable?

No. It provides append-only enforcement in Obsidian and tamper evidence for changes made outside the append path. It never claims true immutability.

### What happens with Obsidian Sync conflicts?

Each writer has its own file, so devices should not produce competing edits to one chain. If sync still delivers a non-append state, Trace warns and verifies rather than fighting the sync engine.

### Why is another actor’s file read-only?

Only the owning writer should append to its actor file. Other devices can verify it, but they never auto-revert it.

### What is re-baseline?

Re-baseline is an explicit, confirmed recovery action for this device’s own files. It accepts the current content as the new trusted state, renumbers entries, recomputes anchors, and appends a visible `#rebaseline` entry. Old external anchors will no longer verify.

### Why is cross-writer ordering approximate?

Each writer file has its own total order by sequence number. Across writers, Trace can only sort by timestamps and tie-breakers. Device clocks can be wrong, so consumers that need exact cross-writer ordering must add their own coordination layer.

### Can Trace automatically log every vault file change?

Not in v1. Automatic vault-wide logging would capture sync deliveries and background plugin writes, creating noisy duplicate attestations. Use **Record file change** or explicit agent/script attestations instead.

### How should agents use Trace?

Treat each agent as an actor with its own chain. Agents append work entries and `#attest` entries for files they touched. A supervisor stores each agent’s last-seen full head outside the vault, verifies progression on every read, and merges timelines for review.

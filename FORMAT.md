# Trace file format — `tracev1`

This document is the normative specification of the Trace file format. It is
sufficient to implement a parser and verifier without the Trace plugin or the
Obsidian API. The reference implementation is [`reference/parser.ts`](reference/parser.ts);
where prose and reference implementation disagree, this document wins.

Trace files are plain Markdown. They are designed to be:

- **Append-only**: new entries are only ever added at the end of the file.
- **Tamper-evident**: every entry carries a hash that commits to the entire
  file content up to and including that entry.
- **Externally parseable**: any tool that can read UTF-8 text and compute
  SHA-256 can parse and verify a trace file using only this document.

## 1. One writer per file

A **logical trace** (a named timeline, e.g. "Project log") is physically
stored as **one active file per writer (actor)**. Each file contains a single
hash chain written by exactly one actor. This exists because sync systems
(including Obsidian Sync) auto-merge concurrent edits to a shared Markdown
file, which would fork a shared hash chain during normal use. With one writer
per active file, no two devices ever produce competing edits to the same file.
Long-running or high-volume writer files may rotate into multiple segments;
each segment remains a one-writer hash chain.

### 1.1 File naming

Default segmented layout:

```
Traces/<trace-slug>/<segment>-<start-month>.<actor-slug>.md
```

Example:

```
Traces/project-log/0001-2026-07.laptop.md
```

- `segment` is a four-digit per-actor segment number, starting at `0001`.
- `start-month` is the UTC month when the segment was created, `YYYY-MM`.
- Sequence numbers reset per file segment.

Legacy flat files are also valid and continue to verify:

```
Traces/<trace-slug>.<actor-slug>.md
```

Both slugs match:

```
slug = [a-z0-9]+(-[a-z0-9]+)*        (1–60 characters total)
```

Slugs are derived from human-readable names by:

1. Unicode NFKD normalization, then removal of combining marks (diacritics).
2. Lowercasing.
3. Replacing every maximal run of characters outside `[a-z0-9]` with a single `-`.
4. Trimming leading and trailing `-`.
5. Truncating to 60 characters, then trimming a trailing `-` again.

A name whose slug is empty is invalid. Two distinct names that produce the
same slug **must be rejected** at creation time (filesystems on Windows and
macOS are case-insensitive; slugs are the collision-safe identity). Pretty
names live in frontmatter; slugs live in filenames.

## 2. File structure

A trace file is UTF-8 text with `\n` line endings:

```
frontmatter
entry-line 1  (the genesis or rotation entry, seq = 1)
entry-line 2
...
entry-line N
```

- The file **must** begin with YAML frontmatter (section 3).
- After the frontmatter, every non-blank line **must** be an entry line
  (section 4). Blank lines are permitted between entries and are ignored.
  Any other content makes the file invalid.
- The file **should** end with a single trailing `\n`.
- Entry lines appear in sequence order; the first entry has `seq = 1`.
  The first segment for a writer starts with `#genesis`; later rotated
  segments start with `#rotate` (section 4.3).

## 3. Frontmatter

YAML frontmatter delimited by `---` lines. Required keys:

| Key          | Type    | Meaning                                              |
| ------------ | ------- | ---------------------------------------------------- |
| `trace`      | boolean | Always `true`. Marks the file as a trace.            |
| `format`     | string  | Always `tracev1` for this version.                   |
| `trace_name` | string  | Human-readable logical trace name.                   |
| `trace_slug` | string  | Slug of `trace_name`; must match the filename.       |
| `actor_name` | string  | Human-readable writer name at file creation.         |
| `actor_slug` | string  | Slug of the actor; must match the filename.          |
| `actor_id`   | string  | Opaque stable writer id (UUID). Owns the file.       |

Values are plain YAML scalars, one `key: value` per line. Writers must quote
string values with double quotes when they contain characters outside
`[A-Za-z0-9 ._-]`, escaping `\` and `"` with a backslash. Parsers must accept
both quoted and unquoted scalars. No other YAML features (multiline values,
lists, nested maps) are used by `tracev1`.

Unknown extra keys are permitted and ignored by verifiers. The frontmatter is
**not** part of the hash chain; the chain covers entries only. Ownership and
naming metadata are advisory — integrity claims come from the chain.

## 4. Entry grammar

One entry per line, six fields (five when the optional tag is absent), in
fixed order, separated by the three-character sequence `" | "`
(space, pipe, space):

```
- <seq> | <timestamp> | <actor> | <tag> | <text> | #<hash8>
- <seq> | <timestamp> | <actor> | <text> | #<hash8>
```

As a single regular expression (POSIX classes expanded, applied to a whole
line):

```
^- (0|[1-9][0-9]*) \| ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z) \| ([^|\\#\r\n ][^|\\\r\n]*?) \| (?:(#[a-z0-9][a-z0-9_-]*) \| )?((?:[^|\\\r\n]|\\[\\nr|])+) \| #([0-9a-f]{8})$
```

Field definitions:

1. **`seq`** — decimal integer, no leading zeros, starting at `1` for the
   genesis entry and incrementing by exactly 1 per entry. (`0` is matched by
   the regex so that a verifier can report "sequence must start at 1" rather
   than "unparseable line".)
2. **`timestamp`** — ISO-8601 UTC with seconds precision, exactly
   `YYYY-MM-DDTHH:MM:SSZ`. Informational: `seq` defines order within a file,
   not the timestamp.
3. **`actor`** — the writer's friendly name, repeated in each entry so a file
   is self-contained when excerpted. Constraints: non-empty; must not contain
   `|`, `\`, CR, or LF; must not begin with `#` or a space; must not end with
   a space.
4. **`tag`** (optional) — `#` followed by `[a-z0-9][a-z0-9_-]*`. When the
   entry has no tag, the field is omitted entirely (five fields total). Field
   count disambiguates: raw `|` never occurs inside any field value, so a
   compliant line splits on `" | "` into exactly 5 or 6 fields. The tags
   `#genesis`, `#rebaseline`, `#attest`, and `#rotate` are reserved for
   protocol-owned entries and cannot be redefined as user tags.
5. **`text`** — the entry body, non-empty, single line, escaped per
   section 4.1.
6. **`hash8`** — `#` followed by the first 8 lowercase hex characters of the
   entry's full chain hash (section 5). This is the entry's **anchor id**.

### 4.1 Text escaping

`text` stores an arbitrary single-line-or-multi-line string using exactly
four escape sequences:

| Source character | Escaped form |
| ---------------- | ------------ |
| `\` (backslash)  | `\\`         |
| LF (U+000A)      | `\n`         |
| CR (U+000D)      | `\r`         |
| `\|` (pipe)      | `\|`         |

Escaping is applied left-to-right; every other character is copied verbatim.
Unescaping reverses this; a `\` followed by anything other than `\`, `n`,
`r`, or `|` makes the line invalid. Because every `|` in escaped text is
immediately preceded by `\`, the separator `" | "` can never occur inside a
field value, and splitting a line on `" | "` is unambiguous.

The escaped form is what appears in the file **and** what is hashed. The
source text must be non-empty.

### 4.2 Attestation entries (`#attest` convention)

`#attest` is a protocol-owned tag for entries that attest to vault file
content. It does **not** change the entry grammar: the structured payload is
stored in the existing text field. A malformed attestation payload is a
convention issue, not a chain failure; verifiers must still verify the entry
hash exactly as written.

The payload is compact `key=value` text. Tokens are separated by one ASCII
space. Keys are lowercase ASCII identifiers. Values are UTF-8 strings encoded
with percent-encoding: bytes outside `[A-Za-z0-9._~/-]` are written as
uppercase `%HH`. Decoding and then re-encoding must reproduce the exact value.
The key order is fixed:

```
path=<path> change=create sha256=<64-lowercase-hex>
path=<path> change=modify sha256=<64-lowercase-hex>
path=<path> change=delete
from=<old-path> to=<new-path> change=rename sha256=<64-lowercase-hex>
```

`path`, `from`, and `to` are vault-relative paths. `sha256` is the content
hash of the file after the change and is omitted for deletes. Example:

```
- 7 | 2026-07-08T14:32:11Z | agent-a | #attest | path=Projects/plan.md change=modify sha256=9f2c000000000000000000000000000000000000000000000000000000000000 | #abcd1234
```

External consumers use attestations as follows: find the latest `#attest` for
the path in the merged timeline, hash the current vault file bytes, and compare
to `sha256`. A match means the reference is current. A mismatch means either a
newer attestation exists and should be followed, or the file changed without an
attestation. That undocumented change is a first-class signal; it is not an
error in the trace. Rename and delete attestations allow references to move or
end deliberately.

### 4.3 Rotation entries (`#rotate` convention)

`#rotate` is a protocol-owned tag for the first entry in a rotated segment. It
links the new segment back to the verified head of the previous segment. It does
not change the hash-chain construction: the new file is its own chain whose
entry 1 hashes against `GENESIS`.

The text payload is canonical `key=value` form, using the same percent-encoding
rules as attestations:

```
previous=<path> previous_seq=<positive-integer> previous_head=<64-lowercase-hex>
```

Example:

```
previous=Traces/project-log/0001-2026-07.laptop.md previous_seq=812 previous_head=9f2c000000000000000000000000000000000000000000000000000000000000
```

External consumers verify continuity by:

1. verifying the previous segment,
2. confirming its last sequence equals `previous_seq`,
3. confirming its full head hash equals `previous_head`, and
4. verifying the new segment normally.

A missing or malformed rotation payload is a convention issue, not an entry
syntax or hash-chain failure.

## 5. Hash chain

### 5.1 Canonical serialization

The canonical form of entry *n* is the UTF-8 string:

```
C(n) = seq "|" timestamp "|" actor "|" tag "|" escaped-text
```

- Single `|` separators, **no spaces**.
- `tag` is the literal tag field including its leading `#`, or the **empty
  string** when the entry has no tag (the separators remain, producing `||`).
- `escaped-text` is the text exactly as it appears in the file (section 4.1).
- The hash field is **not** part of the canonical form.

Example: the line

```
- 42 | 2026-07-08T14:32:11Z | laptop | #agent | Completed nightly export | #a1b2c3d4
```

has canonical form

```
42|2026-07-08T14:32:11Z|laptop|#agent|Completed nightly export
```

### 5.2 Chain construction

```
H(0) = GENESIS = "0000000000000000000000000000000000000000000000000000000000000000"
H(n) = lowercase-hex( SHA-256( UTF-8( H(n-1) + "\n" + C(n) ) ) )
```

- `H(n-1)` is the **full** 64-character lowercase hex digest of the previous
  entry (not the 8-character anchor), joined to `C(n)` by a single LF.
- `GENESIS` is the fixed constant of 64 ASCII `0` characters; entry 1 hashes
  against it.
- The anchor stored in the file is `H(n)` truncated to its first 8 hex
  characters. Full hashes are recovered by recomputing the chain from the
  start of the file — which any verifier does anyway.

### 5.3 Verification

A verifier walks the entries in file order and reports the **first** failure
with its `seq` and line number:

1. Line does not match the entry grammar → invalid line.
2. `seq` ≠ previous `seq` + 1 (or first entry's `seq` ≠ 1) → sequence gap,
   duplicate, or missing genesis. A gap proves entries were removed; a
   duplicate proves entries were inserted or the file was merged.
3. First 8 hex of recomputed `H(n)` ≠ stored anchor → chain break: the entry
   itself, or some entry before it, changed after it was written.

A file with zero entries after valid frontmatter is reported as missing its
genesis entry. Timestamps that go backwards are **not** an integrity failure
(clocks move); verifiers may surface them as informational notices.

**What verification proves:** if `H(n)` matches, then (up to SHA-256
collision resistance) no entry with `seq ≤ n` has been altered, reordered,
removed, or inserted since the anchors were written. An external system that
records the anchor `#a1b2c3d4` of entry 42 can later re-verify that entries
1–42 are byte-for-byte what they were. Anchors are compared with 32 bits
(8 hex digits); verifiers recompute full 256-bit values internally, so
forging a tampered prefix would still require matching every subsequent
recomputed anchor.

### 5.4 Trusted head state (plugin-side, informative)

The plugin additionally records, per file path, the last known head
(`seq`, full `H(n)`, entry count, SHA-256 of full file content) in its plugin
data store — keyed **by file**, never by device, because plugin data syncs
between devices. This witness detects **truncation from the end** (file valid
but shorter than last known head), which in-file verification alone cannot
distinguish from "no new entries".

Precedence when file and stored state disagree: **the file is what external
parties verify and is treated as the candidate truth; the stored state is
evidence of what this plugin last wrote.** Disagreement is reported as tamper
evidence ("content changed outside the append path — edit, sync merge, or
external tool"), and appends to that file are suspended. The user resolves it
with an explicit **re-baseline** (section 7), after which the file as it
stands becomes the new trusted state. A file that is merely *ahead* of the
stored state but chain-valid (e.g. plugin data synced later than the file)
is accepted silently and the state is updated.

### 5.5 External appends

The standalone reference library exposes `appendEntry(text, entry)`. It parses
and verifies the current actor file, computes the next sequence number and hash,
and returns the new file text with the entry appended in canonical form. External
writers (scripts, CLI agents, MCP servers) must obey the same one-writer-per-file
rule as Obsidian devices: they are the sole writer of their actor file.

The plugin append path and reference `appendEntry` use the same grammar and hash
rules. For the same current file, actor, tag, text, and timestamp they produce
byte-identical appended entry lines.

### 5.6 Head progression and supervisor trust

A hash chain alone cannot protect a trace from its own writer. A writer with file
access can rewrite history and recompute every later anchor. A trace is
trustworthy against its writer only when a party outside that writer's reach
stores the last-seen full head `{seq, hash}` and checks progression on every
read.

The reference library exposes:

- `headOf(text)` — verifies the file and returns the current `{seq, hash}`.
- `verifyProgression(oldHead, text)` — verifies that the old head is present at
  the same sequence with the same full hash and that everything after it is a
  valid, contiguous append. Failures distinguish rewritten history
  (`head-not-found`), invalid/tampered suffix (`chain-invalid`), and sequence
  gaps or duplicates (`gap`).

For agent supervision, store each agent actor's head outside the vault. Agents
can append and attest work, but they cannot forge history the supervisor has
already seen without failing `verifyProgression`.

## 6. Cross-writer ordering

Within one file, `seq` gives a total order. **Across files** of the same
logical trace there is no total order: timelines are merged by `timestamp`,
which is only as accurate as each device's clock. Merge rules
(`mergeTimelines` in the reference parser):

1. Sort by `timestamp` ascending (ISO-8601 UTC strings sort lexicographically).
2. Ties: actor label ascending, then `seq` ascending.
3. Entries from one actor always remain in `seq` order relative to each
   other; rule 1 never reorders a single writer because a writer's own
   appends may still carry non-monotonic timestamps after a clock change —
   if so, the merge preserves `seq` order for that writer and flags the
   affected entries.

The merged timeline is **approximate under clock skew** and carries no
integrity guarantee of its own; integrity is per-chain. Consumers who need
exact cross-writer ordering must impose it externally (e.g. one writer, or a
coordination layer).

## 7. Re-baseline

Re-baselining is the explicit, user-confirmed act of accepting a file's
current content as the new trusted state after tampering or an unresolvable
divergence. Semantics:

1. Every line after the frontmatter must parse as an entry line (grammar
   only; hashes and seq may be wrong). Unparseable lines must be repaired or
   removed by the user first.
2. Sequence numbers are rewritten to be continuous from 1 in file order.
3. The chain is recomputed from `GENESIS` and every anchor is rewritten.
4. A new entry with the reserved tag `#rebaseline` is appended, recording
   that the operation happened; it is a normal chain entry.

Re-baselining **re-mints the chain**: anchors issued before it are no longer
verifiable against the file. External systems holding old anchors will
detect this (verification fails), which is the honest outcome — continuity
was broken and the `#rebaseline` entry is the visible record of where.

## 8. Versioning

`format: tracev1` in frontmatter identifies this specification. Any change
to the entry grammar, canonical serialization, escaping, genesis constant,
or chain construction requires a new format token. Parsers must refuse to
*verify* files with an unknown `format` (parsing may still be attempted on a
best-effort basis).

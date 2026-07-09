/**
 * Reference parser and verifier for the `tracev1` file format.
 *
 * Normative specification: FORMAT.md (this file implements it; the document
 * wins on any disagreement).
 *
 * Standalone by design: no dependencies, no Obsidian imports. Runs in any
 * runtime with Web Crypto (`crypto.subtle`: browsers, Node 18+, Deno, Bun,
 * Obsidian desktop and mobile). The Trace plugin imports this module for all
 * format logic, so plugin and reference verifier cannot drift.
 */

/** Format token carried in frontmatter (`format: tracev1`). */
export const FORMAT_TOKEN = "tracev1";

/** Fixed genesis constant: entry 1 hashes against 64 ASCII zeros. */
export const GENESIS =
	"0000000000000000000000000000000000000000000000000000000000000000";

/** Frontmatter keys required by tracev1. */
export const REQUIRED_FRONTMATTER_KEYS = [
	"trace",
	"format",
	"trace_name",
	"trace_slug",
	"actor_name",
	"actor_slug",
	"actor_id",
] as const;

/** Field separator between entry fields on a line. */
export const FIELD_SEPARATOR = " | ";

/** Reserved tags written by trace operations, not by users. */
export const RESERVED_TAGS = ["#genesis", "#rebaseline", "#attest"] as const;

const SEQ_RE = /^(0|[1-9][0-9]*)$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ACTOR_RE = /^[^|\\#\r\n ][^|\\\r\n]*$/;
const TAG_RE = /^#[a-z0-9][a-z0-9_-]*$/;
const TEXT_RE = /^(?:[^|\\\r\n]|\\[\\nr|])+$/;
const ANCHOR_RE = /^#[0-9a-f]{8}$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const ATTESTATION_VALUE_RE = /^(?:[A-Za-z0-9._~/-]|%[0-9A-F]{2})+$/;

/** A parsed entry line. `text` is the unescaped body; `escapedText` is the
 * exact field content as stored in the file (and as hashed). */
export interface TraceEntry {
	seq: number;
	timestamp: string;
	actor: string;
	tag: string | null;
	text: string;
	escapedText: string;
	/** First 8 hex chars of the full chain hash, as stored in the file. */
	anchor: string;
	/** 1-based line number in the file. */
	line: number;
}

export type IssueCode =
	| "MISSING_FRONTMATTER"
	| "BAD_FRONTMATTER"
	| "UNKNOWN_FORMAT"
	| "BAD_LINE"
	| "MISSING_GENESIS"
	| "SEQ_GAP"
	| "SEQ_DUPLICATE"
	| "BAD_TIMESTAMP"
	| "HASH_MISMATCH"
	| "TRUNCATED";

export interface Issue {
	code: IssueCode;
	/** 1-based line number the issue anchors to (0 = whole file). */
	line: number;
	/** Sequence number of the affected entry, when known. */
	seq?: number;
	message: string;
}

export type FrontmatterValue = string | boolean;

export type ConventionIssueCode = "unparseable-attestation";

export interface ConventionIssue {
	code: ConventionIssueCode;
	/** 1-based line number the issue anchors to (0 = whole file). */
	line: number;
	/** Sequence number of the affected entry, when known. */
	seq?: number;
	message: string;
}

export type AttestationChange = "create" | "modify" | "delete" | "rename";

export type AttestationPayload =
	| { change: "create" | "modify"; path: string; sha256: string }
	| { change: "delete"; path: string }
	| { change: "rename"; from: string; to: string; sha256: string };

export type AttestationParseResult =
	| { ok: true; payload: AttestationPayload }
	| { ok: false; message: string };

export interface ParseResult {
	frontmatter: Record<string, FrontmatterValue> | null;
	entries: TraceEntry[];
	issues: Issue[];
	/** Convention-level findings; these never make the trace grammar invalid. */
	conventionIssues: ConventionIssue[];
	/** True when frontmatter is valid and every non-blank body line parsed. */
	ok: boolean;
}

export interface VerifiedEntry extends TraceEntry {
	/** Full 64-hex recomputed chain hash, when the chain was intact up to
	 * this entry; null after the first chain break. */
	fullHash: string | null;
}

export interface VerifyResult {
	ok: boolean;
	entryCount: number;
	/** Full 64-hex hash of the last entry when the whole chain verified. */
	headHash: string | null;
	entries: VerifiedEntry[];
	issues: Issue[];
	/** Convention-level findings; these never make the chain invalid. */
	conventionIssues: ConventionIssue[];
}

export interface TimelineItem {
	/** Label supplied by the caller for the source file. */
	actor: string;
	entry: TraceEntry;
	/** Anchor id external systems cite: `#` + 8 hex. */
	anchor: string;
	/** True when per-writer seq order forced this item to appear after an
	 * item with a later timestamp (clock skew or clock change). */
	outOfOrder: boolean;
}

export interface MergeResult {
	timeline: TimelineItem[];
	/** Parse issues per input, labeled with the caller's actor label. */
	issues: { actor: string; issue: Issue }[];
	/** Convention issues per input, labeled with the caller's actor label. */
	conventionIssues: { actor: string; issue: ConventionIssue }[];
}

export interface AppendEntryInput {
	actor: string;
	tag?: string | null;
	text: string;
	/** Optional for deterministic fixtures; omitted in normal use. */
	timestamp?: string;
}

export interface TraceHead {
	seq: number;
	/** Full 64-character chain hash. */
	hash: string;
}

export type ProgressionStatus = "ok" | "head-not-found" | "chain-invalid" | "gap";

export interface ProgressionResult {
	ok: boolean;
	status: ProgressionStatus;
	message: string;
	oldHead: TraceHead;
	currentHead: TraceHead | null;
	issue?: Issue;
}

/** Derive a filename slug from a human-readable name per FORMAT.md §1.1.
 * Returns "" when the name yields no usable characters. */
export function slugify(name: string): string {
	let slug = name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.length > 60) {
		slug = slug.slice(0, 60).replace(/-+$/g, "");
	}
	return slug;
}

/** True when `slug` is a well-formed tracev1 slug. */
export function isValidSlug(slug: string): boolean {
	return slug.length > 0 && slug.length <= 60 && SLUG_RE.test(slug);
}

function encodeAttestationValue(value: string): string {
	return encodeURIComponent(value)
		.replace(/[!'()*]/g, (ch) =>
			"%" + ch.charCodeAt(0).toString(16).toUpperCase()
		)
		.replace(/%2F/g, "/");
}

function decodeAttestationValue(value: string): string | null {
	if (!ATTESTATION_VALUE_RE.test(value)) return null;
	try {
		const decoded = decodeURIComponent(value);
		return encodeAttestationValue(decoded) === value ? decoded : null;
	} catch {
		return null;
	}
}

/** Serialize a protocol-owned #attest text payload. Keys are emitted in the
 * deterministic order documented in FORMAT.md. */
export function formatAttestationPayload(payload: AttestationPayload): string {
	if (payload.change === "rename") {
		return [
			`from=${encodeAttestationValue(payload.from)}`,
			`to=${encodeAttestationValue(payload.to)}`,
			"change=rename",
			`sha256=${payload.sha256}`,
		].join(" ");
	}
	const parts = [
		`path=${encodeAttestationValue(payload.path)}`,
		`change=${payload.change}`,
	];
	if (payload.change !== "delete") parts.push(`sha256=${payload.sha256}`);
	return parts.join(" ");
}

/** Parse a #attest key=value payload. Failure is a convention error, not a
 * trace grammar or chain failure. */
export function parseAttestationPayload(text: string): AttestationParseResult {
	const fields = new Map<string, string>();
	for (const token of text.split(" ")) {
		if (token.length === 0) {
			return { ok: false, message: "empty token in attestation payload" };
		}
		const eq = token.indexOf("=");
		if (eq <= 0 || eq === token.length - 1) {
			return { ok: false, message: `attestation token "${token}" is not key=value` };
		}
		const key = token.slice(0, eq);
		if (!/^[a-z][a-z0-9_]*$/.test(key)) {
			return { ok: false, message: `invalid attestation key "${key}"` };
		}
		if (fields.has(key)) {
			return { ok: false, message: `duplicate attestation key "${key}"` };
		}
		fields.set(key, token.slice(eq + 1));
	}

	const change = fields.get("change");
	if (
		change !== "create" &&
		change !== "modify" &&
		change !== "delete" &&
		change !== "rename"
	) {
		return { ok: false, message: "attestation change must be create, modify, delete, or rename" };
	}

	const requireValue = (key: string): string | AttestationParseResult => {
		const raw = fields.get(key);
		if (raw === undefined) return { ok: false, message: `missing attestation key "${key}"` };
		const decoded = decodeAttestationValue(raw);
		if (decoded === null) return { ok: false, message: `invalid attestation value for "${key}"` };
		return decoded;
	};
	const requireSha = (): string | AttestationParseResult => {
		const sha = fields.get("sha256");
		if (sha === undefined) return { ok: false, message: "missing attestation key \"sha256\"" };
		if (!SHA256_HEX_RE.test(sha)) {
			return { ok: false, message: "attestation sha256 must be 64 lowercase hex characters" };
		}
		return sha;
	};
	const onlyKeys = (keys: string[]): AttestationParseResult | null => {
		for (const key of fields.keys()) {
			if (!keys.includes(key)) {
				return { ok: false, message: `unexpected attestation key "${key}"` };
			}
		}
		return null;
	};
	const canonical = (payload: AttestationPayload): AttestationParseResult =>
		formatAttestationPayload(payload) === text
			? { ok: true, payload }
			: {
				ok: false,
				message: "attestation payload must use canonical key order and encoding",
			};

	if (change === "rename") {
		const unexpected = onlyKeys(["from", "to", "change", "sha256"]);
		if (unexpected) return unexpected;
		const from = requireValue("from");
		if (typeof from !== "string") return from;
		const to = requireValue("to");
		if (typeof to !== "string") return to;
		const sha256 = requireSha();
		if (typeof sha256 !== "string") return sha256;
		return canonical({ change, from, to, sha256 });
	}

	const keys = change === "delete" ? ["path", "change"] : ["path", "change", "sha256"];
	const unexpected = onlyKeys(keys);
	if (unexpected) return unexpected;
	const path = requireValue("path");
	if (typeof path !== "string") return path;
	if (change === "delete") return canonical({ change, path });
	const sha256 = requireSha();
	if (typeof sha256 !== "string") return sha256;
	return canonical({ change, path, sha256 });
}

/** Escape entry text for storage: `\` `LF` `CR` `|` → `\\` `\n` `\r` `\|`. */
export function escapeText(text: string): string {
	let out = "";
	for (const ch of text) {
		if (ch === "\\") out += "\\\\";
		else if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "|") out += "\\|";
		else out += ch;
	}
	return out;
}

/** Reverse of escapeText. Returns null for invalid escape sequences. */
export function unescapeText(escaped: string): string | null {
	let out = "";
	for (let i = 0; i < escaped.length; i++) {
		const ch = escaped[i];
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		const next = escaped[i + 1];
		if (next === "\\") out += "\\";
		else if (next === "n") out += "\n";
		else if (next === "r") out += "\r";
		else if (next === "|") out += "|";
		else return null;
		i++;
	}
	return out;
}

/** Fields that define an entry prior to hashing. */
export interface EntryFields {
	seq: number;
	timestamp: string;
	actor: string;
	tag: string | null;
	/** Unescaped body text. */
	text: string;
}

/** Canonical serialization hashed into the chain (FORMAT.md §5.1):
 * `seq|timestamp|actor|tag|escaped-text`, empty string for a missing tag. */
export function canonicalize(fields: EntryFields): string {
	return [
		String(fields.seq),
		fields.timestamp,
		fields.actor,
		fields.tag ?? "",
		escapeText(fields.text),
	].join("|");
}

/** SHA-256 of bytes as lowercase hex. */
export async function sha256Bytes(input: Uint8Array | ArrayBuffer): Promise<string> {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** SHA-256 of a UTF-8 string as lowercase hex. */
export async function sha256Hex(input: string): Promise<string> {
	return sha256Bytes(new TextEncoder().encode(input));
}

/** Full chain hash of one entry: SHA-256(prevFullHash + "\n" + canonical). */
export async function computeEntryHash(
	prevFullHash: string,
	fields: EntryFields
): Promise<string> {
	return sha256Hex(prevFullHash + "\n" + canonicalize(fields));
}

/** Anchor id as stored in the file: first 8 hex of the full hash. */
export function toAnchor(fullHash: string): string {
	return fullHash.slice(0, 8);
}

/** Serialize an entry to its file line (without trailing newline). */
export function formatEntryLine(fields: EntryFields, fullHash: string): string {
	const parts = [
		String(fields.seq),
		fields.timestamp,
		fields.actor,
	];
	if (fields.tag !== null) parts.push(fields.tag);
	parts.push(escapeText(fields.text), "#" + toAnchor(fullHash));
	return "- " + parts.join(FIELD_SEPARATOR);
}

/** Validate entry field values before serialization. Returns a list of
 * human-readable problems; empty when the fields are storable. */
export function validateFields(fields: EntryFields): string[] {
	const problems: string[] = [];
	if (!Number.isInteger(fields.seq) || fields.seq < 1) {
		problems.push("seq must be an integer ≥ 1");
	}
	if (!TIMESTAMP_RE.test(fields.timestamp)) {
		problems.push("timestamp must be YYYY-MM-DDTHH:MM:SSZ (UTC)");
	}
	if (!ACTOR_RE.test(fields.actor) || fields.actor.endsWith(" ")) {
		problems.push(
			"actor must be non-empty, must not contain | \\ or line breaks, and must not start with # or start/end with a space"
		);
	}
	if (fields.tag !== null && !TAG_RE.test(fields.tag)) {
		problems.push("tag must match #[a-z0-9][a-z0-9_-]*");
	}
	if (fields.text.length === 0) {
		problems.push("text must be non-empty");
	}
	return problems;
}

/** Parse a single entry line. Returns null when the line does not match the
 * grammar. `line` is the 1-based line number recorded on the entry. */
export function parseEntryLine(raw: string, line = 0): TraceEntry | null {
	if (!raw.startsWith("- ")) return null;
	const fieldsRaw = raw.slice(2).split(FIELD_SEPARATOR);
	if (fieldsRaw.length !== 5 && fieldsRaw.length !== 6) return null;
	const hasTag = fieldsRaw.length === 6;
	const [seqRaw, timestamp, actor] = fieldsRaw;
	const tag = hasTag ? fieldsRaw[3] : null;
	const escapedText = fieldsRaw[hasTag ? 4 : 3];
	const anchorRaw = fieldsRaw[hasTag ? 5 : 4];

	if (!SEQ_RE.test(seqRaw)) return null;
	if (!TIMESTAMP_RE.test(timestamp)) return null;
	if (!ACTOR_RE.test(actor) || actor.endsWith(" ")) return null;
	if (tag !== null && !TAG_RE.test(tag)) return null;
	if (!TEXT_RE.test(escapedText)) return null;
	if (!ANCHOR_RE.test(anchorRaw)) return null;
	const text = unescapeText(escapedText);
	if (text === null) return null;

	return {
		seq: parseInt(seqRaw, 10),
		timestamp,
		actor,
		tag,
		text,
		escapedText,
		anchor: anchorRaw.slice(1),
		line,
	};
}

function parseFrontmatterValue(raw: string): FrontmatterValue | null {
	const trimmed = raw.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed.startsWith('"')) {
		if (!trimmed.endsWith('"') || trimmed.length < 2) return null;
		const inner = trimmed.slice(1, -1);
		let out = "";
		for (let i = 0; i < inner.length; i++) {
			const ch = inner[i];
			if (ch === '"') return null;
			if (ch === "\\") {
				const next = inner[i + 1];
				if (next !== "\\" && next !== '"') return null;
				out += next;
				i++;
			} else {
				out += ch;
			}
		}
		return out;
	}
	return trimmed;
}

/** Serialize a frontmatter string value, quoting when needed (FORMAT.md §3). */
export function formatFrontmatterValue(value: FrontmatterValue): string {
	if (typeof value === "boolean") return value ? "true" : "false";
	if (/^[A-Za-z0-9 ._-]+$/.test(value) && value === value.trim()
		&& value !== "true" && value !== "false") {
		return value;
	}
	return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Parse a whole trace file: frontmatter plus entry lines.
 *
 * Structural/grammar level only — sequence continuity and hashes are checked
 * by verifyTrace. Never throws; problems are collected in `issues`.
 * Tolerates CRLF line endings by stripping a trailing CR per line (writers
 * always emit LF; sync or checkout may convert).
 */
export function parseTrace(text: string): ParseResult {
	const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
	const issues: Issue[] = [];
	const conventionIssues: ConventionIssue[] = [];
	const entries: TraceEntry[] = [];
	let frontmatter: Record<string, FrontmatterValue> | null = null;
	let bodyStart = 0;

	if (lines[0] === "---") {
		const end = lines.indexOf("---", 1);
		if (end === -1) {
			issues.push({
				code: "BAD_FRONTMATTER",
				line: 1,
				message: "Frontmatter is not closed with ---",
			});
			return {
				frontmatter: null,
				entries,
				issues,
				conventionIssues,
				ok: false,
			};
		}
		frontmatter = {};
		for (let i = 1; i < end; i++) {
			const line = lines[i];
			if (line.trim() === "") continue;
			const colon = line.indexOf(":");
			if (colon === -1) {
				issues.push({
					code: "BAD_FRONTMATTER",
					line: i + 1,
					message: `Frontmatter line is not "key: value"`,
				});
				continue;
			}
			const key = line.slice(0, colon).trim();
			const value = parseFrontmatterValue(line.slice(colon + 1));
			if (key === "" || value === null) {
				issues.push({
					code: "BAD_FRONTMATTER",
					line: i + 1,
					message: "Frontmatter value could not be parsed",
				});
				continue;
			}
			frontmatter[key] = value;
		}
		bodyStart = end + 1;
		for (const key of REQUIRED_FRONTMATTER_KEYS) {
			if (!(key in frontmatter)) {
				issues.push({
					code: "BAD_FRONTMATTER",
					line: 1,
					message: `Missing required frontmatter key "${key}"`,
				});
			}
		}
	} else {
		issues.push({
			code: "MISSING_FRONTMATTER",
			line: 1,
			message: "File does not begin with --- frontmatter",
		});
	}

	for (let i = bodyStart; i < lines.length; i++) {
		const raw = lines[i];
		if (raw.trim() === "") continue;
		const entry = parseEntryLine(raw, i + 1);
		if (entry === null) {
			issues.push({
				code: "BAD_LINE",
				line: i + 1,
				message: "Line is neither blank nor a valid entry",
			});
			continue;
		}
		entries.push(entry);
		if (entry.tag === "#attest") {
			const attestation = parseAttestationPayload(entry.text);
			if (!attestation.ok) {
				conventionIssues.push({
					code: "unparseable-attestation",
					line: entry.line,
					seq: entry.seq,
					message: attestation.message,
				});
			}
		}
	}

	return {
		frontmatter,
		entries,
		issues,
		conventionIssues,
		ok: issues.length === 0,
	};
}

/**
 * Verify a trace file: parse, then check sequence continuity and the hash
 * chain (FORMAT.md §5.3). After the first chain break, later entries are not
 * hash-checked (their expected hashes are indeterminate), but sequence
 * continuity is still reported.
 */
export async function verifyTrace(text: string): Promise<VerifyResult> {
	const parsed = parseTrace(text);
	const issues: Issue[] = [...parsed.issues];
	const conventionIssues = [...parsed.conventionIssues];
	const entries: VerifiedEntry[] = [];

	const format = parsed.frontmatter?.["format"];
	if (parsed.frontmatter !== null && format !== FORMAT_TOKEN) {
		issues.push({
			code: "UNKNOWN_FORMAT",
			line: 1,
			message: `Unknown format "${String(format)}" (expected ${FORMAT_TOKEN}); chain not verified`,
		});
		return {
			ok: false,
			entryCount: parsed.entries.length,
			headHash: null,
			entries: parsed.entries.map((e) => ({ ...e, fullHash: null })),
			issues,
			conventionIssues,
		};
	}

	if (parsed.entries.length === 0) {
		issues.push({
			code: "MISSING_GENESIS",
			line: 0,
			message: "Trace has no entries (genesis entry with seq 1 required)",
		});
	}

	let prevSeq = 0;
	let prevHash: string | null = GENESIS;
	let chainBroken = false;

	for (const entry of parsed.entries) {
		if (entry.seq !== prevSeq + 1) {
			if (prevSeq === 0) {
				issues.push({
					code: "MISSING_GENESIS",
					line: entry.line,
					seq: entry.seq,
					message: `First entry has seq ${entry.seq}; genesis must be seq 1`,
				});
			} else if (entry.seq <= prevSeq) {
				issues.push({
					code: "SEQ_DUPLICATE",
					line: entry.line,
					seq: entry.seq,
					message: `Sequence went from ${prevSeq} to ${entry.seq}; entries inserted, duplicated, or reordered`,
				});
			} else {
				issues.push({
					code: "SEQ_GAP",
					line: entry.line,
					seq: entry.seq,
					message: `Sequence jumped from ${prevSeq} to ${entry.seq}; ${entry.seq - prevSeq - 1} entr${entry.seq - prevSeq - 1 === 1 ? "y" : "ies"} missing`,
				});
			}
		}
		prevSeq = entry.seq;

		if (Number.isNaN(Date.parse(entry.timestamp))) {
			issues.push({
				code: "BAD_TIMESTAMP",
				line: entry.line,
				seq: entry.seq,
				message: `Timestamp "${entry.timestamp}" is not a real date-time`,
			});
		}

		let fullHash: string | null = null;
		if (!chainBroken && prevHash !== null) {
			const computed = await computeEntryHash(prevHash, entry);
			if (toAnchor(computed) === entry.anchor) {
				fullHash = computed;
				prevHash = computed;
			} else {
				issues.push({
					code: "HASH_MISMATCH",
					line: entry.line,
					seq: entry.seq,
					message: `Anchor #${entry.anchor} does not match recomputed #${toAnchor(computed)}; content at or before seq ${entry.seq} changed after it was written`,
				});
				chainBroken = true;
				prevHash = null;
			}
		}
		entries.push({ ...entry, fullHash });
	}

	const ok = issues.length === 0;
	return {
		ok,
		entryCount: parsed.entries.length,
		headHash: ok && entries.length > 0
			? entries[entries.length - 1].fullHash
			: null,
		entries,
		issues,
		conventionIssues,
	};
}

function nowTimestamp(now: Date = new Date()): string {
	return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Append one entry to an already-valid actor file and return the new bytes. */
export async function appendEntry(
	text: string,
	entry: AppendEntryInput
): Promise<string> {
	const verified = await verifyTrace(text);
	if (!verified.ok || verified.headHash === null) {
		throw new Error("Cannot append to a trace whose current chain is invalid");
	}
	const last = verified.entries[verified.entries.length - 1];
	if (!last) {
		throw new Error("Cannot append to a trace without a genesis entry");
	}
	const fields: EntryFields = {
		seq: last.seq + 1,
		timestamp: entry.timestamp ?? nowTimestamp(),
		actor: entry.actor,
		tag: entry.tag ?? null,
		text: entry.text,
	};
	const problems = validateFields(fields);
	if (problems.length > 0) {
		throw new Error(problems.join("; "));
	}
	const fullHash = await computeEntryHash(verified.headHash, fields);
	const line = formatEntryLine(fields, fullHash);
	const glue = text === "" || text.endsWith("\n") ? "" : "\n";
	return text + glue + line + "\n";
}

/** Return the verified current head, or null when the trace does not verify. */
export async function headOf(text: string): Promise<TraceHead | null> {
	const verified = await verifyTrace(text);
	if (!verified.ok || verified.headHash === null) return null;
	const last = verified.entries[verified.entries.length - 1];
	return last ? { seq: last.seq, hash: verified.headHash } : null;
}

/** Verify that `oldHead` is still an ancestor and the suffix after it is an
 * intact append-only progression. */
export async function verifyProgression(
	oldHead: TraceHead,
	text: string
): Promise<ProgressionResult> {
	const verified = await verifyTrace(text);
	const matched = oldHead.seq === 0 && oldHead.hash === GENESIS
		? { line: 0 }
		: verified.entries.find(
			(entry) => entry.seq === oldHead.seq && entry.fullHash === oldHead.hash
		);
	const last = verified.entries[verified.entries.length - 1];
	const currentHead = last?.fullHash
		? { seq: last.seq, hash: last.fullHash }
		: null;

	if (!matched) {
		return {
			ok: false,
			status: "head-not-found",
			message: `Stored head seq ${oldHead.seq} is not present with the expected hash; history was rewritten or truncated`,
			oldHead,
			currentHead,
		};
	}

	const afterOld = verified.issues.filter((issue) => {
		if (issue.seq !== undefined) return issue.seq > oldHead.seq;
		return issue.line > matched.line;
	});
	const gap = afterOld.find(
		(issue) => issue.code === "SEQ_GAP" || issue.code === "SEQ_DUPLICATE"
	);
	if (gap) {
		return {
			ok: false,
			status: "gap",
			message: gap.message,
			oldHead,
			currentHead,
			issue: gap,
		};
	}
	const invalid = afterOld[0];
	if (invalid) {
		return {
			ok: false,
			status: "chain-invalid",
			message: invalid.message,
			oldHead,
			currentHead,
			issue: invalid,
		};
	}
	if (currentHead === null) {
		return {
			ok: false,
			status: "chain-invalid",
			message: "Trace head could not be verified",
			oldHead,
			currentHead,
		};
	}
	return {
		ok: true,
		status: "ok",
		message: "Stored head is an ancestor of the current trace head",
		oldHead,
		currentHead,
	};
}

/**
 * Merge multiple writers' files of one logical trace into a single timeline
 * ordered by timestamp (FORMAT.md §6). Each writer's entries keep their seq
 * order relative to each other; ties break on actor label, then seq. Items
 * forced out of global timestamp order by per-writer seq order are flagged
 * `outOfOrder`. Ordering is approximate under clock skew; integrity remains
 * per-chain.
 */
export function mergeTimelines(
	files: { actor: string; text: string }[]
): MergeResult {
	const issues: MergeResult["issues"] = [];
	const conventionIssues: MergeResult["conventionIssues"] = [];
	const sources = files.map((f) => {
		const parsed = parseTrace(f.text);
		for (const issue of parsed.issues) {
			issues.push({ actor: f.actor, issue });
		}
		for (const issue of parsed.conventionIssues) {
			conventionIssues.push({ actor: f.actor, issue });
		}
		return { actor: f.actor, entries: parsed.entries, next: 0 };
	});

	const timeline: TimelineItem[] = [];
	let lastEmitted = "";
	for (;;) {
		let best: (typeof sources)[number] | null = null;
		for (const src of sources) {
			if (src.next >= src.entries.length) continue;
			if (best === null) {
				best = src;
				continue;
			}
			const a = src.entries[src.next];
			const b = best.entries[best.next];
			if (
				a.timestamp < b.timestamp ||
				(a.timestamp === b.timestamp &&
					(src.actor < best.actor ||
						(src.actor === best.actor && a.seq < b.seq)))
			) {
				best = src;
			}
		}
		if (best === null) break;
		const entry = best.entries[best.next++];
		timeline.push({
			actor: best.actor,
			entry,
			anchor: "#" + entry.anchor,
			outOfOrder: entry.timestamp < lastEmitted,
		});
		if (entry.timestamp > lastEmitted) lastEmitted = entry.timestamp;
	}

	return { timeline, issues, conventionIssues };
}

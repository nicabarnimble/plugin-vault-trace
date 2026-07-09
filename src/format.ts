/**
 * Plugin-side format helpers. All grammar, hashing, and chain logic lives in
 * the standalone reference parser (reference/parser.ts) and is imported from
 * there — single source of truth, no drift. This module adds what only the
 * plugin needs: timestamps, file naming, frontmatter assembly, and the
 * display template.
 */

import {
	EntryFields,
	FORMAT_TOKEN,
	FrontmatterValue,
	TraceEntry,
	formatFrontmatterValue,
	isValidSlug,
	slugify,
} from "../reference/parser";

export {
	FIELD_SEPARATOR,
	FORMAT_TOKEN,
	GENESIS,
	RESERVED_TAGS,
	appendEntry,
	canonicalize,
	computeEntryHash,
	escapeText,
	formatAttestationPayload,
	formatEntryLine,
	formatRotationPayload,
	headOf,
	isValidSlug,
	mergeTimelines,
	parseAttestationPayload,
	parseEntryLine,
	parseRotationPayload,
	parseTrace,
	sha256Bytes,
	slugify,
	toAnchor,
	unescapeText,
	validateFields,
	verifyProgression,
	verifyTrace,
} from "../reference/parser";
export type {
	AppendEntryInput,
	AttestationPayload,
	AttestationParseResult,
	ConventionIssue,
	ConventionIssueCode,
	EntryFields,
	Issue,
	IssueCode,
	MergeResult,
	ParseResult,
	ProgressionResult,
	ProgressionStatus,
	RotationParseResult,
	RotationPayload,
	TimelineItem,
	TraceEntry,
	TraceHead,
	VerifiedEntry,
	VerifyResult,
} from "../reference/parser";

/** Identity of a trace file: pretty names, slugs, and the owning actor id. */
export interface TraceFileMeta {
	traceName: string;
	traceSlug: string;
	actorName: string;
	actorSlug: string;
	actorId: string;
}

/** Current time as the tracev1 timestamp: ISO-8601 UTC, seconds precision. */
export function nowTimestamp(now: Date = new Date()): string {
	return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Build the legacy flat basename for a writer's file of a logical trace. */
export function traceFileName(traceSlug: string, actorSlug: string): string {
	return `${traceSlug}.${actorSlug}.md`;
}

/** Segment start label used in rotated file names (`YYYY-MM`). */
export function currentSegmentMonth(now: Date = new Date()): string {
	return now.toISOString().slice(0, 7);
}

/** Build the segmented basename for a writer's file of a logical trace. */
export function traceSegmentFileName(
	segment: number,
	startMonth: string,
	actorSlug: string
): string {
	return `${String(segment).padStart(4, "0")}-${startMonth}.${actorSlug}.md`;
}

/** Build the segmented path for a writer's file of a logical trace. */
export function traceSegmentPath(
	tracesFolder: string,
	traceSlug: string,
	segment: number,
	startMonth: string,
	actorSlug: string
): string {
	const folder = tracesFolder ? tracesFolder + "/" : "";
	return folder + traceSlug + "/" + traceSegmentFileName(segment, startMonth, actorSlug);
}

/** Parse `<trace-slug>.<actor-slug>.md` back into its slugs, or null. */
export function parseTraceFileName(
	name: string
): { traceSlug: string; actorSlug: string } | null {
	const parts = name.split(".");
	if (parts.length !== 3 || parts[2] !== "md") return null;
	const [traceSlug, actorSlug] = parts;
	if (!isValidSlug(traceSlug) || !isValidSlug(actorSlug)) return null;
	return { traceSlug, actorSlug };
}

export interface TracePathInfo {
	traceSlug: string;
	actorSlug: string;
	/** Null for legacy flat files. */
	segment: number | null;
	/** Null for legacy flat files. */
	startMonth: string | null;
	legacy: boolean;
}

/** Parse a trace path in either supported layout:
 * `Traces/<trace>.<actor>.md` or
 * `Traces/<trace>/<0001>-<YYYY-MM>.<actor>.md`. */
export function parseTracePath(
	path: string,
	tracesFolder: string
): TracePathInfo | null {
	const prefix = tracesFolder ? tracesFolder.replace(/^\/+|\/+$/g, "") + "/" : "";
	if (prefix && !path.startsWith(prefix)) return null;
	const rest = prefix ? path.slice(prefix.length) : path;
	const parts = rest.split("/");
	if (parts.length === 1) {
		const legacy = parseTraceFileName(parts[0]);
		return legacy ? { ...legacy, segment: null, startMonth: null, legacy: true } : null;
	}
	if (parts.length !== 2) return null;
	const [traceSlug, name] = parts;
	if (!isValidSlug(traceSlug)) return null;
	const match = /^(\d{4})-(\d{4}-\d{2})\.([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(name);
	if (!match) return null;
	const segment = parseInt(match[1], 10);
	const startMonth = match[2];
	const actorSlug = match[3];
	if (segment < 1 || !isValidSlug(actorSlug)) return null;
	return { traceSlug, actorSlug, segment, startMonth, legacy: false };
}

/** Sort key for choosing the current writer file. Segmented files sort after
 * legacy flat files; higher segment numbers are newer. */
export function tracePathOrder(path: string, tracesFolder: string): number {
	const info = parseTracePath(path, tracesFolder);
	return info?.segment ?? 0;
}

/** Serialize the required tracev1 frontmatter block. */
export function buildFrontmatter(meta: TraceFileMeta): string {
	const pairs: [string, FrontmatterValue][] = [
		["trace", true],
		["format", FORMAT_TOKEN],
		["trace_name", meta.traceName],
		["trace_slug", meta.traceSlug],
		["actor_name", meta.actorName],
		["actor_slug", meta.actorSlug],
		["actor_id", meta.actorId],
	];
	const lines = pairs.map(([k, v]) => `${k}: ${formatFrontmatterValue(v)}`);
	return "---\n" + lines.join("\n") + "\n---\n";
}

/** Read TraceFileMeta out of parsed frontmatter; null when incomplete. */
export function metaFromFrontmatter(
	fm: Record<string, unknown> | null | undefined
): TraceFileMeta | null {
	if (!fm) return null;
	const traceName = fm["trace_name"];
	const traceSlug = fm["trace_slug"];
	const actorName = fm["actor_name"];
	const actorSlug = fm["actor_slug"];
	const actorId = fm["actor_id"];
	if (
		fm["trace"] !== true ||
		typeof traceName !== "string" ||
		typeof traceSlug !== "string" ||
		typeof actorName !== "string" ||
		typeof actorSlug !== "string" ||
		typeof actorId !== "string"
	) {
		return null;
	}
	return { traceName, traceSlug, actorName, actorSlug, actorId };
}

/** Fields of the genesis entry written when a writer's file is created. */
export function genesisFields(
	meta: TraceFileMeta,
	timestamp: string
): EntryFields {
	return {
		seq: 1,
		timestamp,
		actor: meta.actorName,
		tag: "#genesis",
		text: `Trace "${meta.traceName}" started by ${meta.actorName}`,
	};
}

/** Validate a human-readable actor or trace name. Returns an error message
 * or null. Names must be storable in entry lines and produce a valid slug. */
export function validateName(name: string): string | null {
	if (name.trim() !== name || name.length === 0) {
		return "Name must not be empty or start/end with a space";
	}
	if (/[|\\\r\n]/.test(name)) {
		return "Name must not contain |, \\, or line breaks";
	}
	if (name.startsWith("#")) {
		return "Name must not start with #";
	}
	if (!isValidSlug(slugify(name))) {
		return "Name must contain at least one letter or digit";
	}
	return null;
}

// --- Display template -------------------------------------------------------
//
// The template never changes what is written to disk: file lines are always
// the canonical grammar from FORMAT.md, so external parseability cannot
// break. The template only decorates how entries are rendered in reading
// view. Placeholders are required, each exactly once, in canonical field
// order; everything between them is free-form decoration.

export const TEMPLATE_PLACEHOLDERS = [
	"{{seq}}",
	"{{timestamp}}",
	"{{actor}}",
	"{{tag}}",
	"{{text}}",
	"{{hash}}",
] as const;

export const DEFAULT_TEMPLATE =
	"{{seq}} | {{timestamp}} | {{actor}} | {{tag}} | {{text}} | {{hash}}";

/** Validate a display template. Returns an error message or null. */
export function validateTemplate(template: string): string | null {
	let rest = template;
	for (const ph of TEMPLATE_PLACEHOLDERS) {
		const first = rest.indexOf(ph);
		if (first === -1) {
			const inFull = template.indexOf(ph) !== -1;
			return inFull
				? `Placeholders must appear in canonical order (${ph} is out of order)`
				: `Template must contain ${ph}`;
		}
		rest = rest.slice(first + ph.length);
	}
	for (const ph of TEMPLATE_PLACEHOLDERS) {
		const first = template.indexOf(ph);
		if (template.indexOf(ph, first + ph.length) !== -1) {
			return `Template must contain ${ph} exactly once`;
		}
	}
	const leftover = template
		.replace(/\{\{(seq|timestamp|actor|tag|text|hash)\}\}/g, "")
		.match(/\{\{[^}]*\}\}/);
	if (leftover) {
		return `Unknown placeholder ${leftover[0]}`;
	}
	return null;
}

export interface TemplateSegment {
	kind: "literal" | "seq" | "timestamp" | "actor" | "tag" | "text" | "hash";
	value: string;
}

/** Render an entry through a display template into typed segments, so the
 * caller can attach CSS classes per field without innerHTML. */
export function renderTemplateSegments(
	template: string,
	entry: TraceEntry
): TemplateSegment[] {
	const values: Record<string, string> = {
		seq: String(entry.seq),
		timestamp: entry.timestamp,
		actor: entry.actor,
		tag: entry.tag ?? "",
		text: entry.text,
		hash: "#" + entry.anchor,
	};
	const segments: TemplateSegment[] = [];
	const re = /\{\{(seq|timestamp|actor|tag|text|hash)\}\}/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(template)) !== null) {
		if (m.index > last) {
			segments.push({ kind: "literal", value: template.slice(last, m.index) });
		}
		const kind = m[1] as TemplateSegment["kind"];
		segments.push({ kind, value: values[m[1]] });
		last = m.index + m[0].length;
	}
	if (last < template.length) {
		segments.push({ kind: "literal", value: template.slice(last) });
	}
	return segments;
}

/** Render an entry through a display template to a plain string. */
export function renderTemplate(template: string, entry: TraceEntry): string {
	return renderTemplateSegments(template, entry)
		.map((s) => s.value)
		.join("");
}

import { App, Notice, TFile } from "obsidian";
import { editorInfoField } from "obsidian";
import { EditorState, Extension } from "@codemirror/state";
import { TraceFileMeta } from "./format";
import {
	TraceEntry,
	computeEntryHash,
	parseEntryLine,
	sha256Hex,
	toAnchor,
	verifyTrace,
} from "../reference/parser";
import { ChainStore, TraceWriter } from "./hashchain";
import { Identity } from "./identity";
import { TraceSettings } from "./settings";

/** What the guard needs from the plugin, kept as an interface to avoid a
 * circular import with main.ts. */
export interface GuardHost {
	app: App;
	getSettings(): TraceSettings;
	getIdentity(): Identity | null;
	/** Meta for a trace file path, or null when the path is not a trace. */
	getMeta(path: string): TraceFileMeta | null;
	chain: ChainStore;
	writer: TraceWriter | null;
}

// --- Pure helpers (unit-tested without Obsidian) ----------------------------

export type ChangeClass =
	| { kind: "unchanged" }
	| { kind: "append"; tail: string }
	| { kind: "rewrite" };

/** Classify a modification against the last known good content: strict
 * prefix growth is an append candidate; anything else rewrote history. */
export function classifyChange(
	oldContent: string,
	newContent: string
): ChangeClass {
	if (newContent === oldContent) return { kind: "unchanged" };
	if (newContent.startsWith(oldContent)) {
		return { kind: "append", tail: newContent.slice(oldContent.length) };
	}
	return { kind: "rewrite" };
}

export interface TailValidation {
	ok: boolean;
	reason?: string;
	/** Sequence and full hash of the new head after the appended entries. */
	seq?: number;
	head?: string;
	entries?: TraceEntry[];
}

/**
 * Validate that an appended tail is a run of well-formed entries continuing
 * the chain: consecutive seq, correct hashes computed from the previous
 * head, and the file's own actor name. This is how the plugin recognizes a
 * legitimate append it did not perform itself (another process following
 * FORMAT.md, or sync delivering the owning device's appends).
 */
export async function validateAppendedTail(
	tail: string,
	prevSeq: number,
	prevHead: string,
	expectedActor: string
): Promise<TailValidation> {
	const lines = tail.split("\n");
	let seq = prevSeq;
	let head = prevHead;
	const entries: TraceEntry[] = [];
	for (const line of lines) {
		if (line.trim() === "") continue;
		const entry = parseEntryLine(line);
		if (entry === null) {
			return { ok: false, reason: "appended line is not a valid entry" };
		}
		if (entry.seq !== seq + 1) {
			return {
				ok: false,
				reason: `appended entry has seq ${entry.seq}, expected ${seq + 1}`,
			};
		}
		if (entry.actor !== expectedActor) {
			return {
				ok: false,
				reason: `appended entry actor "${entry.actor}" does not match this file's writer "${expectedActor}"`,
			};
		}
		const computed = await computeEntryHash(head, entry);
		if (toAnchor(computed) !== entry.anchor) {
			return {
				ok: false,
				reason: `appended entry #${entry.anchor} does not continue the chain`,
			};
		}
		seq = entry.seq;
		head = computed;
		entries.push(entry);
	}
	if (entries.length === 0) {
		return { ok: false, reason: "no entries in appended content" };
	}
	return { ok: true, seq, head, entries };
}

/**
 * Offset before which an editor may not change a trace file: everything
 * through the frontmatter and the last valid entry line (including its
 * trailing newline) is protected; only the tail beyond it is editable.
 */
export function protectedEndOffset(doc: string): number {
	const lines = doc.split("\n");
	let offset = 0;
	let protectedEnd = 0;
	let inFrontmatter = false;
	let frontmatterClosed = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineEnd = offset + line.length;
		const withNewline = Math.min(lineEnd + 1, doc.length);
		if (i === 0 && line === "---") {
			inFrontmatter = true;
			protectedEnd = withNewline;
		} else if (inFrontmatter && !frontmatterClosed) {
			protectedEnd = withNewline;
			if (line === "---") frontmatterClosed = true;
		} else if (parseEntryLine(line) !== null) {
			protectedEnd = withNewline;
		}
		offset = lineEnd + 1;
	}
	return protectedEnd;
}

// --- Guard ------------------------------------------------------------------

interface CacheEntry {
	content: string;
	/** True once the content was read fresh from disk this session (or was
	 * produced by our own write). Until then the guard never auto-reverts. */
	confirmed: boolean;
}

const SELF_WRITE_WINDOW_MS = 3000;
const DEBOUNCE_MS = 350;
const STARTUP_GRACE_MS = 45000;
const REVERT_WINDOW_MS = 120000;
const MAX_REVERTS_PER_WINDOW = 2;
const NOTICE_THROTTLE_MS = 5000;

/**
 * Ownership-aware append-only enforcement.
 *
 * Own files: modifications must be strict-prefix growth with a chain-valid
 * tail; anything else is a violation — reverted in enforce mode, warned in
 * warn mode. Reverts are conservative: never during the startup grace
 * window, never before the cache is confirmed, and never more than
 * MAX_REVERTS_PER_WINDOW per file (a second fight over the same file means
 * we may be arguing with a sync engine, and the guard must lose that fight
 * gracefully — warn and let "Verify integrity" tell the story).
 *
 * Other writers' files: never reverted, only verified and warned.
 */
export class TraceGuard {
	private cache = new Map<string, CacheEntry>();
	private selfWrites = new Map<string, number>();
	private timers = new Map<string, number>();
	private reverts = new Map<string, number[]>();
	private lastNotice = new Map<string, number>();
	private readyAt = Date.now();
	/** Files flagged since last verify; surfaced by the verify command. */
	readonly suspect = new Set<string>();

	constructor(private host: GuardHost) {}

	setWriter(writer: TraceWriter): void {
		this.host.writer = writer;
	}

	private writer(): TraceWriter {
		if (!this.host.writer) {
			throw new Error("Trace writer is not initialized");
		}
		return this.host.writer;
	}

	markSelfWrite(path: string): void {
		this.selfWrites.set(path, Date.now());
	}

	private isSelfWrite(path: string): boolean {
		const at = this.selfWrites.get(path);
		return at !== undefined && Date.now() - at < SELF_WRITE_WINDOW_MS;
	}

	setCache(path: string, content: string): void {
		this.cache.set(path, { content, confirmed: true });
	}

	getCachedContent(path: string): string | null {
		const entry = this.cache.get(path);
		return entry?.confirmed ? entry.content : null;
	}

	dropPath(path: string): void {
		this.cache.delete(path);
		this.suspect.delete(path);
		const timer = this.timers.get(path);
		if (timer !== undefined) {
			window.clearTimeout(timer);
			this.timers.delete(path);
		}
	}

	renamePath(oldPath: string, newPath: string): void {
		const entry = this.cache.get(oldPath);
		this.cache.delete(oldPath);
		if (entry) this.cache.set(newPath, entry);
		if (this.suspect.delete(oldPath)) this.suspect.add(newPath);
	}

	dispose(): void {
		for (const timer of this.timers.values()) {
			window.clearTimeout(timer);
		}
		this.timers.clear();
	}

	/** Read all known trace files once at layout-ready so later modify
	 * events have a trusted baseline; resets the startup grace window. */
	async warmCache(paths: string[]): Promise<void> {
		this.readyAt = Date.now();
		for (const path of paths) {
			const file = this.host.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;
			try {
				const content = await this.host.app.vault.cachedRead(file);
				this.cache.set(path, { content, confirmed: true });
				const state = this.host.chain.get(path);
				if (state && state.contentSha !== (await sha256Hex(content))) {
					await this.reconcile(path, content);
				}
			} catch {
				// unreadable file: leave unconfirmed, never enforce blind
			}
		}
	}

	/** File content differs from the recorded chain state: verify, adopt
	 * silently when the file is simply ahead and intact, warn otherwise. */
	private async reconcile(path: string, content: string): Promise<void> {
		const meta = this.host.getMeta(path);
		if (!meta) return;
		const state = this.host.chain.get(path);
		const result = await verifyTrace(content);
		if (result.ok && result.headHash !== null) {
			const lastSeq = result.entries[result.entries.length - 1].seq;
			if (!state || lastSeq > state.seq) {
				await this.host.chain.set(path, {
					seq: lastSeq,
					head: result.headHash,
					entryCount: result.entryCount,
					contentSha: await sha256Hex(content),
					updatedAt: new Date().toISOString(),
				});
				return;
			}
			if (lastSeq === state.seq && result.headHash === state.head) {
				await this.host.chain.set(path, {
					...state,
					contentSha: await sha256Hex(content),
				});
				return;
			}
		}
		this.suspect.add(path);
		this.notice(
			`Trace "${meta.traceName}" (${meta.actorName}): content changed outside the append path (edit, sync merge, or external tool). Run "Verify integrity".`,
			path
		);
	}

	onModify(file: TFile): void {
		const path = file.path;
		if (!this.host.getMeta(path)) return;
		if (this.isSelfWrite(path)) return;
		const existing = this.timers.get(path);
		if (existing !== undefined) window.clearTimeout(existing);
		this.timers.set(
			path,
			window.setTimeout(() => {
				this.timers.delete(path);
				void this.evaluate(path);
			}, DEBOUNCE_MS)
		);
	}

	private async evaluate(path: string): Promise<void> {
		const meta = this.host.getMeta(path);
		if (!meta) return;
		if (this.isSelfWrite(path)) return;
		const file = this.host.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		let newContent: string;
		try {
			newContent = await this.host.app.vault.read(file);
		} catch {
			return;
		}
		const cached = this.cache.get(path);
		if (!cached || !cached.confirmed) {
			// No trusted baseline (startup, or first sight of this file):
			// warn-and-verify, never revert.
			this.cache.set(path, { content: newContent, confirmed: true });
			await this.reconcile(path, newContent);
			return;
		}

		const change = classifyChange(cached.content, newContent);
		if (change.kind === "unchanged") return;

		if (change.kind === "append") {
			const state = this.host.chain.get(path);
			const cachedSha = await sha256Hex(cached.content);
			if (state && state.contentSha === cachedSha) {
				const tailCheck = await validateAppendedTail(
					change.tail,
					state.seq,
					state.head,
					meta.actorName
				);
				if (tailCheck.ok && tailCheck.head && tailCheck.seq && tailCheck.entries) {
					this.cache.set(path, { content: newContent, confirmed: true });
					await this.host.chain.set(path, {
						seq: tailCheck.seq,
						head: tailCheck.head,
						entryCount: state.entryCount + tailCheck.entries.length,
						contentSha: await sha256Hex(newContent),
						updatedAt: new Date().toISOString(),
					});
					return;
				}
			} else {
				// No baseline state for the cached content — verify the
				// whole file; a fully intact chain that is not behind the
				// recorded head is a legitimate append.
				const result = await verifyTrace(newContent);
				if (result.ok && result.headHash !== null) {
					const lastSeq =
						result.entries[result.entries.length - 1].seq;
					if (!state || lastSeq >= state.seq) {
						this.cache.set(path, {
							content: newContent,
							confirmed: true,
						});
						await this.host.chain.set(path, {
							seq: lastSeq,
							head: result.headHash,
							entryCount: result.entryCount,
							contentSha: await sha256Hex(newContent),
							updatedAt: new Date().toISOString(),
						});
						return;
					}
				}
			}
		}

		await this.violation(file, meta, cached.content, newContent);
	}

	private async violation(
		file: TFile,
		meta: TraceFileMeta,
		oldContent: string,
		newContent: string
	): Promise<void> {
		const path = file.path;
		const identity = this.host.getIdentity();
		const own = identity !== null && meta.actorId === identity.actorId;
		const label = `Trace "${meta.traceName}" (${meta.actorName})`;

		if (!own) {
			// Never revert another writer's file: sync may legitimately be
			// delivering a remote state we cannot judge from here.
			this.suspect.add(path);
			this.cache.set(path, { content: newContent, confirmed: true });
			this.notice(
				`${label}: content changed outside the append path (edit, sync merge, or external tool). Run "Verify integrity".`,
				path
			);
			return;
		}

		const mode = this.host.getSettings().enforcementMode;
		const inGrace = Date.now() - this.readyAt < STARTUP_GRACE_MS;
		if (mode === "enforce" && !inGrace && this.mayRevert(path)) {
			this.recordRevert(path);
			await this.writer().replaceContent(file, oldContent, null);
			this.cache.set(path, { content: oldContent, confirmed: true });
			this.notice(
				`${label}: content changed outside the append path — reverted to the last verified state.`,
				path
			);
			return;
		}

		this.suspect.add(path);
		this.cache.set(path, { content: newContent, confirmed: true });
		const suffix =
			mode === "enforce"
				? "Not auto-reverted (recent start or repeated changes — possibly sync). "
				: "";
		this.notice(
			`${label}: content changed outside the append path (edit, sync merge, or external tool). ${suffix}Run "Verify integrity".`,
			path
		);
	}

	private mayRevert(path: string): boolean {
		const now = Date.now();
		const recent = (this.reverts.get(path) ?? []).filter(
			(t) => now - t < REVERT_WINDOW_MS
		);
		this.reverts.set(path, recent);
		return recent.length < MAX_REVERTS_PER_WINDOW;
	}

	private recordRevert(path: string): void {
		const list = this.reverts.get(path) ?? [];
		list.push(Date.now());
		this.reverts.set(path, list);
	}

	onRename(file: TFile, oldPath: string): void {
		if (this.isSelfWrite(oldPath) || this.isSelfWrite(file.path)) return;
		const wasTrace = this.cache.has(oldPath) || this.host.chain.get(oldPath);
		this.renamePath(oldPath, file.path);
		void this.host.chain.rename(oldPath, file.path);
		if (wasTrace || this.host.getMeta(file.path)) {
			this.notice(
				`Trace file "${oldPath}" was renamed to "${file.path}". External tools referencing the old path will not find it; the file name should stay <trace>.<actor>.md.`,
				oldPath
			);
		}
	}

	onDelete(path: string): void {
		if (!this.cache.has(path) && !this.host.chain.get(path)) return;
		this.dropPath(path);
		// Chain state is kept on purpose: "Verify all" reports a
		// recorded trace whose file is gone, which is the evidence trail
		// for deletion. The verify view offers to forget it.
		this.notice(
			`Trace file "${path}" was deleted. Its recorded chain state is kept as evidence; run "Verify all" to review or forget it.`,
			path
		);
	}

	notice(message: string, key = ""): void {
		const now = Date.now();
		const last = this.lastNotice.get(key + message) ?? 0;
		if (now - last < NOTICE_THROTTLE_MS) return;
		this.lastNotice.set(key + message, now);
		new Notice(message, 8000);
	}
}

/**
 * CodeMirror 6 extension: other writers' trace files are fully read-only;
 * on the device's own files everything up to the end of the last committed
 * entry (frontmatter included) is read-only, and only the tail can be
 * typed into — whatever lands there must validate as proper entries when it
 * reaches disk, or the modify guard treats it as a violation.
 */
export function buildEditorGuard(
	host: GuardHost & { writer: TraceWriter },
	guard: TraceGuard
): Extension {
	const protectedEnds = new WeakMap<object, number>();
	return EditorState.transactionFilter.of((tr) => {
		if (!tr.docChanged) return tr;
		if (!host.getSettings().readOnlyGuard) return tr;
		const info = tr.startState.field(editorInfoField, false);
		const file = info?.file;
		if (!file) return tr;
		const meta = host.getMeta(file.path);
		if (!meta) return tr;

		const identity = host.getIdentity();
		const own = identity !== null && meta.actorId === identity.actorId;
		if (!own) {
			guard.notice(
				`Read-only: this trace file belongs to "${meta.actorName}". Entries are appended from that device.`,
				file.path
			);
			return [];
		}

		const doc = tr.startState.doc;
		let boundary = protectedEnds.get(doc);
		if (boundary === undefined) {
			boundary = protectedEndOffset(doc.toString());
			protectedEnds.set(doc, boundary);
		}
		let blocked = false;
		tr.changes.iterChangedRanges((fromA) => {
			if (fromA < boundary) blocked = true;
		});
		if (blocked) {
			guard.notice(
				"Trace entries are append-only — existing entries can't be edited. Use the append command instead.",
				file.path
			);
			return [];
		}
		return tr;
	});
}

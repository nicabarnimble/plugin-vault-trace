import { App, TFile, TFolder, Vault } from "obsidian";
import {
	EntryFields,
	TraceFileMeta,
	buildFrontmatter,
	genesisFields,
	nowTimestamp,
	traceFileName,
} from "./format";
import {
	computeEntryHash,
	formatEntryLine,
	sha256Hex,
	toAnchor,
	validateFields,
	verifyTrace,
} from "../reference/parser";

/**
 * Last known trusted head of one trace file, persisted in plugin data —
 * keyed by file path, never by device (plugin data syncs between devices).
 * The file itself is what external parties verify; this state is the
 * plugin's witness of what was last written through the append path, and is
 * what detects truncation from the end. See FORMAT.md §5.4 for precedence.
 */
export interface ChainState {
	seq: number;
	/** Full 64-hex chain hash of the head entry. */
	head: string;
	entryCount: number;
	/** SHA-256 of the entire file content at last trusted write. */
	contentSha: string;
	updatedAt: string;
}

export class ChainStore {
	private states: Record<string, ChainState> = {};

	constructor(private persist: () => Promise<void>) {}

	loadFrom(states: Record<string, ChainState> | undefined): void {
		this.states = states ?? {};
	}

	snapshot(): Record<string, ChainState> {
		return this.states;
	}

	get(path: string): ChainState | null {
		return this.states[path] ?? null;
	}

	async set(path: string, state: ChainState): Promise<void> {
		this.states[path] = state;
		await this.persist();
	}

	async remove(path: string): Promise<void> {
		if (path in this.states) {
			delete this.states[path];
			await this.persist();
		}
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		const state = this.states[oldPath];
		if (state) {
			delete this.states[oldPath];
			this.states[newPath] = state;
			await this.persist();
		}
	}

	paths(): string[] {
		return Object.keys(this.states);
	}
}

export class AppendBlockedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AppendBlockedError";
	}
}

interface WriterDeps {
	app: App;
	chain: ChainStore;
	/** Mark a path as being written by the plugin itself, so the guard's
	 * modify handler does not treat the write as a violation. */
	markSelfWrite: (path: string) => void;
	/** Update the guard's last-known-good content cache. */
	setCache: (path: string, content: string) => void;
}

/** Result of a successful append. */
export interface AppendedEntry {
	seq: number;
	anchor: string;
	line: string;
}

/**
 * The only write path for trace files. Serializes operations per file,
 * computes seq + chain hash, appends via Vault.append, and keeps the chain
 * state and guard cache in step with every write.
 */
export class TraceWriter {
	private queues = new Map<string, Promise<unknown>>();

	constructor(private deps: WriterDeps) {}

	private get vault(): Vault {
		return this.deps.app.vault;
	}

	/** Run `fn` exclusively for `path`; appends to one file never race. */
	private enqueue<T>(path: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.queues.get(path) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		this.queues.set(
			path,
			next.catch(() => undefined)
		);
		return next;
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		if (folderPath === "" || folderPath === "/") return;
		const existing = this.vault.getAbstractFileByPath(folderPath);
		if (existing instanceof TFolder) return;
		if (existing !== null) {
			throw new AppendBlockedError(
				`"${folderPath}" exists but is not a folder`
			);
		}
		await this.vault.createFolder(folderPath);
	}

	/**
	 * Create a new writer file for a logical trace: frontmatter plus the
	 * genesis entry (seq 1). Fails if the file already exists.
	 */
	async createTraceFile(
		folderPath: string,
		meta: TraceFileMeta
	): Promise<TFile> {
		const path =
			(folderPath ? folderPath + "/" : "") +
			traceFileName(meta.traceSlug, meta.actorSlug);
		return this.enqueue(path, async () => {
			if (this.vault.getAbstractFileByPath(path) !== null) {
				throw new AppendBlockedError(`"${path}" already exists`);
			}
			await this.ensureFolder(folderPath);
			const fields = genesisFields(meta, nowTimestamp());
			const fullHash = await computeEntryHash(
				"0".repeat(64),
				fields
			);
			const content =
				buildFrontmatter(meta) + formatEntryLine(fields, fullHash) + "\n";
			this.deps.markSelfWrite(path);
			const file = await this.vault.create(path, content);
			this.deps.setCache(path, content);
			await this.deps.chain.set(path, {
				seq: 1,
				head: fullHash,
				entryCount: 1,
				contentSha: await sha256Hex(content),
				updatedAt: nowTimestamp(),
			});
			return file;
		});
	}

	/**
	 * Append one entry to a writer file. Establishes the trusted head first:
	 * fast path when the file's content hash matches the stored state; slow
	 * path re-verifies the whole file and adopts it when the chain is intact
	 * and not behind the stored state. Anything else blocks the append —
	 * appending onto a suspect chain would fork every anchor after it.
	 */
	async appendEntry(
		file: TFile,
		meta: TraceFileMeta,
		input: { tag: string | null; text: string }
	): Promise<AppendedEntry> {
		return this.enqueue(file.path, async () => {
			const content = await this.vault.read(file);
			const contentSha = await sha256Hex(content);
			const state = this.deps.chain.get(file.path);

			let prevSeq: number;
			let prevHead: string;
			if (state && state.contentSha === contentSha) {
				prevSeq = state.seq;
				prevHead = state.head;
			} else {
				const result = await verifyTrace(content);
				if (!result.ok || result.headHash === null) {
					throw new AppendBlockedError(
						`"${file.path}" failed verification — content changed outside the append path (edit, sync merge, or external tool). Run "Verify integrity".`
					);
				}
				const lastSeq =
					result.entries[result.entries.length - 1].seq;
				if (state && lastSeq < state.seq) {
					throw new AppendBlockedError(
						`"${file.path}" has ${lastSeq} entries but seq ${state.seq} was previously recorded — entries were removed from the end, or sync has not caught up. Run "Verify integrity".`
					);
				}
				if (state && lastSeq === state.seq && result.headHash !== state.head) {
					throw new AppendBlockedError(
						`"${file.path}" diverged from its last recorded head — content changed outside the append path. Run "Verify integrity".`
					);
				}
				prevSeq = lastSeq;
				prevHead = result.headHash;
			}

			const fields: EntryFields = {
				seq: prevSeq + 1,
				timestamp: nowTimestamp(),
				actor: meta.actorName,
				tag: input.tag,
				text: input.text,
			};
			const problems = validateFields(fields);
			if (problems.length > 0) {
				throw new AppendBlockedError(problems.join("; "));
			}
			const fullHash = await computeEntryHash(prevHead, fields);
			const line = formatEntryLine(fields, fullHash);
			const glue = content === "" || content.endsWith("\n") ? "" : "\n";

			this.deps.markSelfWrite(file.path);
			await this.vault.append(file, glue + line + "\n");
			const newContent = content + glue + line + "\n";
			this.deps.setCache(file.path, newContent);
			await this.deps.chain.set(file.path, {
				seq: fields.seq,
				head: fullHash,
				entryCount: fields.seq,
				contentSha: await sha256Hex(newContent),
				updatedAt: nowTimestamp(),
			});
			return { seq: fields.seq, anchor: toAnchor(fullHash), line };
		});
	}

	/**
	 * Replace a file's content through the plugin's own write path (used by
	 * revert and re-baseline). Content must already be fully formed.
	 */
	async replaceContent(
		file: TFile,
		newContent: string,
		newState: ChainState | null
	): Promise<void> {
		return this.enqueue(file.path, async () => {
			this.deps.markSelfWrite(file.path);
			await this.vault.process(file, () => newContent);
			this.deps.setCache(file.path, newContent);
			if (newState) {
				await this.deps.chain.set(file.path, newState);
			}
		});
	}
}

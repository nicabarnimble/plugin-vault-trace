import { App, Modal, Notice, Setting, TFile } from "obsidian";
import {
	Issue,
	VerifyResult,
	sha256Hex,
	verifyTrace,
	computeEntryHash,
	formatEntryLine,
	parseTrace,
	GENESIS,
	EntryFields,
} from "../reference/parser";
import { TraceFileMeta, nowTimestamp } from "./format";
import type TracePlugin from "./main";

export type StateCheck =
	| { code: "ok" | "none" | "adopted"; message: string }
	| { code: "behind" | "diverged"; message: string };

export interface FileReport {
	path: string;
	meta: TraceFileMeta | null;
	own: boolean;
	result: VerifyResult;
	stateCheck: StateCheck;
}

/**
 * Verify one trace file: in-file chain and sequence (FORMAT.md §5.3) plus a
 * comparison against the recorded chain state (§5.4), which is what catches
 * truncation from the end. A chain-valid file that is ahead of the recorded
 * state is adopted silently (plugin data may sync later than the file).
 */
export async function verifyFile(
	plugin: TracePlugin,
	file: TFile
): Promise<FileReport> {
	const content = await plugin.app.vault.read(file);
	const result = await verifyTrace(content);
	const meta = plugin.registry.get(file.path);
	const identity = plugin.identity.get();
	const own =
		meta !== null && identity !== null && meta.actorId === identity.actorId;

	const state = plugin.chain.get(file.path);
	let stateCheck: StateCheck;
	if (!state) {
		stateCheck = {
			code: "none",
			message: "No recorded head on this device yet.",
		};
		if (result.ok && result.headHash !== null) {
			await adoptState(plugin, file.path, content, result);
			stateCheck = { code: "adopted", message: "Recorded as trusted head." };
		}
	} else if (result.ok && result.headHash !== null) {
		const lastSeq = result.entries[result.entries.length - 1].seq;
		if (lastSeq < state.seq) {
			stateCheck = {
				code: "behind",
				message: `File ends at seq ${lastSeq} but seq ${state.seq} was recorded — entries removed from the end, or sync has not delivered them yet.`,
			};
		} else if (
			result.entries[state.seq - 1] &&
			result.entries[state.seq - 1].fullHash !== state.head
		) {
			stateCheck = {
				code: "diverged",
				message: `Entry ${state.seq} no longer matches the recorded head — content was replaced and re-chained outside the append path.`,
			};
		} else {
			await adoptState(plugin, file.path, content, result);
			stateCheck = { code: "ok", message: "Matches the recorded head." };
		}
	} else {
		stateCheck = {
			code: "none",
			message: "Chain invalid; recorded head left untouched.",
		};
	}

	if (result.ok && stateCheck.code !== "behind" && stateCheck.code !== "diverged") {
		plugin.guard.suspect.delete(file.path);
	}
	return { path: file.path, meta, own, result, stateCheck };
}

async function adoptState(
	plugin: TracePlugin,
	path: string,
	content: string,
	result: VerifyResult
): Promise<void> {
	const last = result.entries[result.entries.length - 1];
	if (!last || last.fullHash === null) return;
	await plugin.chain.set(path, {
		seq: last.seq,
		head: last.fullHash,
		entryCount: result.entryCount,
		contentSha: await sha256Hex(content),
		updatedAt: nowTimestamp(),
	});
}

export interface AllTracesReport {
	files: FileReport[];
	/** Cross-file findings per logical trace, plus orphaned chain state. */
	logical: string[];
	/** Paths with recorded state whose file no longer exists. */
	orphanedStates: string[];
}

/** Verify every known trace file plus per-logical-trace sanity checks. */
export async function verifyAllTraces(
	plugin: TracePlugin
): Promise<AllTracesReport> {
	const files: FileReport[] = [];
	const logical: string[] = [];
	const byTrace = new Map<string, FileReport[]>();

	for (const [path, meta] of plugin.registry.all()) {
		const file = plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) continue;
		const report = await verifyFile(plugin, file);
		files.push(report);
		if (meta) {
			const group = byTrace.get(meta.traceSlug) ?? [];
			group.push(report);
			byTrace.set(meta.traceSlug, group);
		}
	}

	for (const [slug, group] of byTrace) {
		const names = new Set(group.map((r) => r.meta?.traceName));
		if (names.size > 1) {
			logical.push(
				`Trace "${slug}": files disagree on the trace name (${[...names].join(", ")}).`
			);
		}
		const byActor = new Map<string, number>();
		for (const r of group) {
			if (!r.meta) continue;
			byActor.set(r.meta.actorId, (byActor.get(r.meta.actorId) ?? 0) + 1);
		}
		for (const [actorId, count] of byActor) {
			if (count > 1) {
				const actorNames = group
					.filter((r) => r.meta?.actorId === actorId)
					.map((r) => r.meta?.actorName)
					.join(", ");
				logical.push(
					`Trace "${slug}": writer id ${actorId} appears in ${count} files (${actorNames}) — likely a renamed device; older files stay valid but no longer grow.`
				);
			}
		}
		for (const r of group) {
			const expectedName = r.meta
				? `${r.meta.traceSlug}.${r.meta.actorSlug}.md`
				: null;
			const basename = r.path.split("/").pop();
			if (expectedName && basename !== expectedName) {
				logical.push(
					`File "${r.path}" should be named "${expectedName}" to match its frontmatter.`
				);
			}
		}
	}

	const orphanedStates = plugin.chain
		.paths()
		.filter(
			(path) => !(plugin.app.vault.getAbstractFileByPath(path) instanceof TFile)
		);
	for (const path of orphanedStates) {
		logical.push(
			`Recorded trace "${path}" no longer exists on disk — deleted or moved outside Obsidian.`
		);
	}

	return { files, logical, orphanedStates };
}

/**
 * Re-baseline (FORMAT.md §7): accept the file's current content as the new
 * trusted state. Rewrites seq to be continuous, recomputes every anchor,
 * and appends a visible #rebaseline entry. Own files only; anchors issued
 * before the re-baseline stop verifying, by design.
 */
export async function rebaseline(
	plugin: TracePlugin,
	file: TFile
): Promise<void> {
	const meta = plugin.registry.get(file.path);
	const identity = plugin.identity.get();
	if (!meta || !identity || meta.actorId !== identity.actorId) {
		throw new Error("Only this device's own trace files can be re-baselined");
	}
	const content = await plugin.app.vault.read(file);
	const parsed = parseTrace(content);
	const badLines = parsed.issues.filter((i) => i.code === "BAD_LINE");
	if (badLines.length > 0) {
		throw new Error(
			`Line ${badLines[0].line} is not a parseable entry — repair or remove unparseable lines first`
		);
	}

	const fmEnd = content.indexOf("\n---\n");
	if (!content.startsWith("---\n") || fmEnd === -1) {
		throw new Error("File is missing its frontmatter");
	}
	const frontmatterBlock = content.slice(0, fmEnd + 5);

	let head = GENESIS;
	const lines: string[] = [];
	let seq = 0;
	for (const entry of parsed.entries) {
		seq += 1;
		const fields: EntryFields = {
			seq,
			timestamp: entry.timestamp,
			actor: entry.actor,
			tag: entry.tag,
			text: entry.text,
		};
		head = await computeEntryHash(head, fields);
		lines.push(formatEntryLine(fields, head));
	}
	seq += 1;
	const marker: EntryFields = {
		seq,
		timestamp: nowTimestamp(),
		actor: meta.actorName,
		tag: "#rebaseline",
		text: "Re-baseline: current content accepted as the new trusted state",
	};
	head = await computeEntryHash(head, marker);
	lines.push(formatEntryLine(marker, head));

	const newContent = frontmatterBlock + lines.join("\n") + "\n";
	await plugin.writer.replaceContent(file, newContent, {
		seq,
		head,
		entryCount: seq,
		contentSha: await sha256Hex(newContent),
		updatedAt: nowTimestamp(),
	});
	plugin.guard.suspect.delete(file.path);
}

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private body: string,
		private confirmLabel: string,
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.title);
		this.contentEl.createEl("p", { text: this.body });
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText(this.confirmLabel)
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function issueLabel(issue: Issue): string {
	const where =
		issue.seq !== undefined
			? `entry ${issue.seq} (line ${issue.line})`
			: issue.line > 0
				? `line ${issue.line}`
				: "file";
	return `${where}: ${issue.message}`;
}

export class VerifyResultsModal extends Modal {
	constructor(
		private plugin: TracePlugin,
		private report: AllTracesReport,
		private heading: string
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		this.render();
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();

		if (this.report.files.length === 0 && this.report.logical.length === 0) {
			root.createEl("p", { text: "No trace files found." });
			return;
		}

		for (const fileReport of this.report.files) {
			const section = root.createDiv({ cls: "trace-verify-file" });
			const ok =
				fileReport.result.ok &&
				fileReport.stateCheck.code !== "behind" &&
				fileReport.stateCheck.code !== "diverged";
			const title = section.createDiv({ cls: "trace-verify-title" });
			title.createSpan({
				cls: ok ? "trace-verify-ok" : "trace-verify-fail",
				text: ok ? "OK" : "Check",
			});
			title.createSpan({
				text: ` ${fileReport.path}${fileReport.own ? " (this device)" : ""}`,
			});

			const detail = section.createEl("ul", { cls: "trace-verify-detail" });
			if (fileReport.result.ok) {
				const head = fileReport.result.headHash;
				detail.createEl("li", {
					text: `${fileReport.result.entryCount} entries verified; head ${
						head ? "#" + head.slice(0, 8) : "n/a"
					}.`,
				});
			}
			for (const issue of fileReport.result.issues) {
				detail.createEl("li", { text: issueLabel(issue) });
			}
			for (const issue of fileReport.result.conventionIssues) {
				detail.createEl("li", {
					text: `Convention issue at entry ${issue.seq ?? "?"}: ${issue.message}`,
				});
			}
			if (
				fileReport.stateCheck.code === "behind" ||
				fileReport.stateCheck.code === "diverged"
			) {
				detail.createEl("li", { text: fileReport.stateCheck.message });
			}

			if (!ok && fileReport.own) {
				new Setting(section).addButton((btn) =>
					btn
						.setButtonText("Re-baseline…")
						.setWarning()
						.onClick(() => this.confirmRebaseline(fileReport.path))
				);
			}
			if (!ok && !fileReport.own) {
				detail.createEl("li", {
					text: "This file belongs to another device; re-baseline it there if its content is correct.",
				});
			}
		}

		if (this.report.logical.length > 0) {
			root.createEl("h3", { text: "Trace-level checks" });
			const list = root.createEl("ul");
			for (const item of this.report.logical) {
				list.createEl("li", { text: item });
			}
		}

		for (const path of this.report.orphanedStates) {
			new Setting(root)
				.setName(`Forget recorded state for "${path}"`)
				.setDesc("Only do this if the deletion was intentional.")
				.addButton((btn) =>
					btn.setButtonText("Forget").onClick(() => {
						void this.plugin.chain.remove(path).then(() => {
							this.report.orphanedStates =
								this.report.orphanedStates.filter((p) => p !== path);
							this.report.logical = this.report.logical.filter(
								(l) => !l.includes(`"${path}"`)
							);
							this.render();
						});
					})
				);
		}
	}

	private confirmRebaseline(path: string): void {
		new ConfirmModal(
			this.app,
			"Re-baseline this trace file?",
			"The current content becomes the new trusted state: sequence numbers are renumbered, every anchor hash is recomputed, and a #rebaseline entry is appended. Anchors that external tools recorded before this point will no longer verify.",
			"Re-baseline",
			() => {
				const file = this.plugin.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) return;
				void rebaseline(this.plugin, file)
					.then(async () => {
						new Notice(`Re-baselined "${path}".`);
						const fresh = await verifyFile(this.plugin, file);
						this.report.files = this.report.files.map((r) =>
							r.path === path ? fresh : r
						);
						this.render();
					})
					.catch((error: unknown) => {
						new Notice(
							`Re-baseline failed: ${error instanceof Error ? error.message : String(error)}`
						);
					});
			}
		).open();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

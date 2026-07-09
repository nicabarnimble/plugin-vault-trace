import { Notice, Plugin, TFile, debounce } from "obsidian";
import {
	AppendEntryModal,
	CreateTraceModal,
	RecordFileChangeModal,
} from "./appendModal";
import {
	TraceFileMeta,
	metaFromFrontmatter,
	parseEntryLine,
	parseTraceFileName,
	renderTemplateSegments,
	slugify,
	traceFileName,
} from "./format";
import { TraceGuard, buildEditorGuard } from "./guard";
import { AppendBlockedError, ChainState, ChainStore, TraceWriter } from "./hashchain";
import {
	DeviceNameModal,
	Identity,
	IdentityManager,
	ReclaimIdentityModal,
	automaticIdentityNotice,
} from "./identity";
import { DEFAULT_SETTINGS, TraceSettingTab, TraceSettings } from "./settings";
import { ConfirmModal, VerifyResultsModal, rebaseline, verifyAllTraces, verifyFile } from "./verify";

interface PluginData {
	settings: TraceSettings;
	chainState: Record<string, ChainState>;
	lastUsedTrace?: string;
}

/** Index of known trace files: which paths are traces and their metadata. */
export class TraceRegistry {
	private files = new Map<string, TraceFileMeta | null>();

	constructor(private plugin: TracePlugin) {}

	rebuild(): void {
		const { app, settings } = this.plugin;
		this.files.clear();
		const folderPrefix = settings.tracesFolder + "/";
		for (const file of app.vault.getMarkdownFiles()) {
			const inFolder =
				file.path.startsWith(folderPrefix) &&
				parseTraceFileName(file.name) !== null;
			const explicit = settings.explicitPaths.includes(file.path);
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			const flagged = settings.useFrontmatterFlag && fm?.["trace"] === true;
			if (!inFolder && !explicit && !flagged) continue;
			if (fm?.["trace"] !== true) continue;
			this.files.set(file.path, metaFromFrontmatter(fm));
		}
	}

	isTrace(path: string): boolean {
		return this.files.has(path);
	}

	/** Complete metadata for a trace file, or null (not a trace, or its
	 * frontmatter is incomplete — verification reports the latter). */
	get(path: string): TraceFileMeta | null {
		return this.files.get(path) ?? null;
	}

	all(): Map<string, TraceFileMeta | null> {
		return this.files;
	}

	/** Distinct logical traces across all writer files. */
	logicalTraces(): { slug: string; name: string }[] {
		const bySlug = new Map<string, string>();
		for (const meta of this.files.values()) {
			if (!meta) continue;
			if (!bySlug.has(meta.traceSlug)) {
				bySlug.set(meta.traceSlug, meta.traceName);
			}
		}
		return [...bySlug.entries()]
			.map(([slug, name]) => ({ slug, name }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Distinct writers seen in trace files, keyed by actor id. */
	uniqueActors(): TraceFileMeta[] {
		const byId = new Map<string, TraceFileMeta>();
		for (const meta of this.files.values()) {
			if (meta && !byId.has(meta.actorId)) byId.set(meta.actorId, meta);
		}
		return [...byId.values()];
	}

	/** This device's writer file for a logical trace, wherever it lives. */
	ownFileFor(traceSlug: string, identity: Identity): string | null {
		for (const [path, meta] of this.files) {
			if (
				meta &&
				meta.traceSlug === traceSlug &&
				meta.actorId === identity.actorId
			) {
				return path;
			}
		}
		return null;
	}
}

export default class TracePlugin extends Plugin {
	settings: TraceSettings = { ...DEFAULT_SETTINGS };
	lastUsedTrace: string | undefined;
	declare identity: IdentityManager;
	declare chain: ChainStore;
	declare writer: TraceWriter;
	declare guard: TraceGuard;
	declare registry: TraceRegistry;

	async onload(): Promise<void> {
		const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
		this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
		this.lastUsedTrace = data.lastUsedTrace;

		this.identity = new IdentityManager(this.app);
		this.identity.load();
		this.chain = new ChainStore(() => this.savePluginData());
		this.chain.loadFrom(data.chainState);
		this.registry = new TraceRegistry(this);
		this.guard = new TraceGuard({
			app: this.app,
			getSettings: () => this.settings,
			getIdentity: () => this.identity.get(),
			getMeta: (path) => this.registry.get(path),
			chain: this.chain,
			writer: null,
		});
		this.writer = new TraceWriter({
			app: this.app,
			chain: this.chain,
			markSelfWrite: (path) => this.guard.markSelfWrite(path),
			setCache: (path, content) => this.guard.setCache(path, content),
		});
		this.guard.setWriter(this.writer);

		this.addSettingTab(new TraceSettingTab(this.app, this));
		this.registerCommands();
		this.registerEditorExtension(
			buildEditorGuard(
				{
					app: this.app,
					getSettings: () => this.settings,
					getIdentity: () => this.identity.get(),
					getMeta: (path) => this.registry.get(path),
					chain: this.chain,
					writer: this.writer,
				},
				this.guard
			)
		);
		this.registerPostProcessor();
		this.registerVaultEvents();

		this.app.workspace.onLayoutReady(() => {
			void this.initAfterLayout();
		});
	}

	onunload(): void {
		this.guard.dispose();
	}

	private async initAfterLayout(): Promise<void> {
		this.registry.rebuild();
		if (!this.identity.get()) {
			const actors = this.registry.uniqueActors();
			if (actors.length > 0) {
				this.promptIdentityRecovery();
			} else {
				automaticIdentityNotice(this.identity.createDefault());
			}
		}
		await this.guard.warmCache([...this.registry.all().keys()]);
	}

	private registerCommands(): void {
		this.addRibbonIcon("list-plus", "Append entry", () => {
			new AppendEntryModal(this).open();
		});

		this.addCommand({
			id: "append-entry",
			name: "Append entry",
			callback: () => new AppendEntryModal(this).open(),
		});

		this.addCommand({
			id: "create-timeline",
			name: "Create timeline",
			callback: () => new CreateTraceModal(this).open(),
		});

		this.addCommand({
			id: "record-file-change",
			name: "Record file change",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) new RecordFileChangeModal(this, file).open();
				return true;
			},
		});

		this.addCommand({
			id: "verify-file",
			name: "Verify integrity",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.registry.isTrace(file.path)) return false;
				if (!checking) {
					void verifyFile(this, file).then((report) => {
						new VerifyResultsModal(
							this,
							{ files: [report], logical: [], orphanedStates: [] },
							`Verify: ${file.name}`
						).open();
					});
				}
				return true;
			},
		});

		this.addCommand({
			id: "verify-all",
			name: "Verify all",
			callback: () => {
				void verifyAllTraces(this).then((report) => {
					new VerifyResultsModal(this, report, "Verify all").open();
				});
			},
		});

		this.addCommand({
			id: "rebaseline-file",
			name: "Re-baseline file",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const identity = this.identity.get();
				const meta = file ? this.registry.get(file.path) : null;
				const own =
					!!meta && !!identity && meta.actorId === identity.actorId;
				if (!file || !own) return false;
				if (!checking) {
					new ConfirmModal(
						this.app,
						"Re-baseline this trace file?",
						"The current content becomes the new trusted state: sequence numbers are renumbered, every anchor hash is recomputed, and a #rebaseline entry is appended. Anchors recorded by external tools before this point will no longer verify.",
						"Re-baseline",
						() => {
							void rebaseline(this, file)
								.then(() => new Notice(`Re-baselined "${file.path}".`))
								.catch((error: unknown) =>
									new Notice(
										`Re-baseline failed: ${error instanceof Error ? error.message : String(error)}`
									)
								);
						}
					).open();
				}
				return true;
			},
		});
	}

	private registerVaultEvents(): void {
		const rebuild = debounce(() => this.registry.rebuild(), 300, true);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile) this.guard.onModify(file);
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) {
					this.guard.onRename(file, oldPath);
					rebuild();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.guard.onDelete(file.path);
				rebuild();
			})
		);
		this.registerEvent(
			this.app.vault.on("create", () => rebuild())
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", () => rebuild())
		);
	}

	private registerPostProcessor(): void {
		this.registerMarkdownPostProcessor((el, ctx) => {
			if (!this.registry.isTrace(ctx.sourcePath)) return;
			el.querySelectorAll("li").forEach((li) => {
				const entry = parseEntryLine("- " + (li.textContent ?? "").trim());
				if (!entry) return;
				li.empty();
				li.addClass("trace-entry");
				const segments = renderTemplateSegments(
					this.settings.displayTemplate,
					entry
				);
				for (const segment of segments) {
					if (segment.value === "") continue;
					li.createSpan({
						cls:
							segment.kind === "literal"
								? "trace-literal"
								: "trace-" + segment.kind,
						text: segment.value,
					});
				}
			});
		});
	}

	// --- Actions ------------------------------------------------------------

	private promptIdentityRecovery(onDone?: () => void): void {
		new ReclaimIdentityModal(
			this.app,
			this.registry.uniqueActors(),
			(meta) => {
				this.identity.reclaim(meta);
				new Notice(`This device now writes as "${meta.actorName}".`);
				onDone?.();
			},
			() => {
				automaticIdentityNotice(this.identity.createDefault());
				onDone?.();
			}
		).open();
	}

	private identityForWrite(onReady: () => void): Identity | null {
		const current = this.identity.get();
		if (current) return current;
		if (this.registry.uniqueActors().length > 0) {
			this.promptIdentityRecovery(onReady);
			return null;
		}
		const identity = this.identity.createDefault();
		automaticIdentityNotice(identity);
		return identity;
	}

	/** Append through the modal path; creates this device's writer file for
	 * the logical trace when it does not exist yet. */
	async appendToTrace(
		traceSlug: string,
		traceName: string,
		tag: string | null,
		text: string
	): Promise<void> {
		const identity = this.identityForWrite(() => {
			void this.appendToTrace(traceSlug, traceName, tag, text);
		});
		if (!identity) return;

		try {
			let path = this.registry.ownFileFor(traceSlug, identity);
			if (path === null) {
				const clash = this.registry
					.uniqueActors()
					.find(
						(a) =>
							a.actorSlug === identity.actorSlug &&
							a.actorId !== identity.actorId
					);
				if (clash) {
					new Notice(
						`This device's name "${identity.actorName}" collides with writer "${clash.actorName}" (both use "${identity.actorSlug}"). Rename this device in Trace settings first.`
					);
					return;
				}
				await this.writer.createTraceFile(this.settings.tracesFolder, {
					traceName,
					traceSlug,
					actorName: identity.actorName,
					actorSlug: identity.actorSlug,
					actorId: identity.actorId,
				});
				this.registry.rebuild();
				path =
					this.settings.tracesFolder +
					"/" +
					traceFileName(traceSlug, identity.actorSlug);
			}
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				new Notice(`Trace file "${path}" is missing.`);
				return;
			}
			const meta = this.registry.get(path) ?? {
				traceName,
				traceSlug,
				actorName: identity.actorName,
				actorSlug: identity.actorSlug,
				actorId: identity.actorId,
			};
			const appended = await this.writer.appendEntry(file, meta, {
				tag,
				text,
			});
			this.lastUsedTrace = traceSlug;
			await this.savePluginData();
			new Notice(
				`Appended entry ${appended.seq} (#${appended.anchor}) to "${traceName}".`
			);
		} catch (error) {
			if (error instanceof AppendBlockedError) {
				new Notice(`Append blocked: ${error.message}`, 10000);
			} else {
				new Notice(
					`Append failed: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
	}

	/** Create a new logical trace (this device's file with genesis). */
	async createTrace(name: string, slug: string): Promise<void> {
		const identity = this.identityForWrite(() => {
			void this.createTrace(name, slug);
		});
		if (!identity) return;
		if (this.registry.ownFileFor(slug, identity)) {
			new Notice(`This device already has a file for trace "${name}".`);
			return;
		}
		try {
			const file = await this.writer.createTraceFile(
				this.settings.tracesFolder,
				{
					traceName: name,
					traceSlug: slug,
					actorName: identity.actorName,
					actorSlug: identity.actorSlug,
					actorId: identity.actorId,
				}
			);
			this.registry.rebuild();
			this.lastUsedTrace = slug;
			await this.savePluginData();
			new Notice(`Created trace "${name}" (${file.path}).`);
			await this.app.workspace.getLeaf(false).openFile(file);
		} catch (error) {
			new Notice(
				`Create failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/** Set or rename this device's writer name (device-local storage). */
	promptDeviceName(onDone?: () => void): void {
		const current = this.identity.get();
		const others = this.registry
			.uniqueActors()
			.filter((a) => a.actorId !== current?.actorId)
			.map((a) => ({ actorSlug: a.actorSlug, actorName: a.actorName }));
		new DeviceNameModal(
			this.app,
			others,
			(name) => {
				if (current) {
					this.identity.save({
						actorId: current.actorId,
						actorName: name,
						actorSlug: slugify(name),
					});
					new Notice(
						`This device now writes as "${name}". Existing owned files continue to receive appends; new writer files use *.${slugify(name)}.md.`
					);
				} else {
					this.identity.create(name);
					new Notice(`This device writes as "${name}".`);
				}
				onDone?.();
			},
			current?.actorName ?? ""
		).open();
	}

	async saveSettings(): Promise<void> {
		await this.savePluginData();
	}

	private async savePluginData(): Promise<void> {
		const data: PluginData = {
			settings: this.settings,
			chainState: this.chain.snapshot(),
			lastUsedTrace: this.lastUsedTrace,
		};
		await this.saveData(data);
	}
}

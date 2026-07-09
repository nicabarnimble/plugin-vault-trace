import { App, Modal, Notice, Setting } from "obsidian";
import { TraceFileMeta, slugify, validateName } from "./format";

/**
 * Writer identity for this device. Stored in per-device local storage
 * (App.saveLocalStorage) and NEVER in plugin data.json: plugin data syncs
 * between devices, and identity that syncs would make every device claim to
 * be the same writer — forking chains during normal use.
 */
export interface Identity {
	actorId: string;
	actorName: string;
	actorSlug: string;
}

const STORAGE_KEY = "trace-identity";

function defaultActorName(actorId: string): string {
	return `Device ${actorId.slice(0, 8)}`;
}

function isIdentity(value: unknown): value is Identity {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.actorId === "string" &&
		v.actorId.length > 0 &&
		typeof v.actorName === "string" &&
		typeof v.actorSlug === "string"
	);
}

export class IdentityManager {
	private identity: Identity | null = null;

	constructor(private app: App) {}

	/** Load identity from device-local storage. */
	load(): Identity | null {
		const raw: unknown = this.app.loadLocalStorage(STORAGE_KEY);
		let value: unknown = raw;
		if (typeof raw === "string") {
			try {
				value = JSON.parse(raw);
			} catch {
				value = null;
			}
		}
		this.identity = isIdentity(value) ? value : null;
		return this.identity;
	}

	get(): Identity | null {
		return this.identity;
	}

	save(identity: Identity): void {
		this.identity = identity;
		this.app.saveLocalStorage(STORAGE_KEY, identity);
	}

	/** Create and persist a brand-new identity for this device. */
	create(actorName: string): Identity {
		const identity: Identity = {
			actorId: crypto.randomUUID(),
			actorName,
			actorSlug: slugify(actorName),
		};
		this.save(identity);
		return identity;
	}

	/** Create and persist an automatic identity for first use. */
	createDefault(): Identity {
		const actorId = crypto.randomUUID();
		const actorName = defaultActorName(actorId);
		const identity: Identity = {
			actorId,
			actorName,
			actorSlug: slugify(actorName),
		};
		this.save(identity);
		return identity;
	}

	/** Adopt an existing actor (identity recovery after cleared storage). */
	reclaim(meta: TraceFileMeta): Identity {
		const identity: Identity = {
			actorId: meta.actorId,
			actorName: meta.actorName,
			actorSlug: meta.actorSlug,
		};
		this.save(identity);
		return identity;
	}
}

/**
 * Validate a proposed device name against known actors. Returns an error
 * message or null. `others` are actors seen in trace files that do NOT
 * belong to `selfId` — a name that slugs identically to another writer's
 * slug is rejected (filenames are the collision domain).
 */
export function checkNameAgainstActors(
	name: string,
	others: { actorSlug: string; actorName: string }[]
): string | null {
	const invalid = validateName(name);
	if (invalid) return invalid;
	const slug = slugify(name);
	const clash = others.find((a) => a.actorSlug === slug);
	if (clash) {
		return `"${name}" would use the file name segment "${slug}", already taken by writer "${clash.actorName}"`;
	}
	return null;
}

/** Prompt for a custom device name (settings rename/customize flow). */
export class DeviceNameModal extends Modal {
	private value = "";

	constructor(
		app: App,
		private otherActors: { actorSlug: string; actorName: string }[],
		private onSubmit: (name: string) => void,
		private initial = ""
	) {
		super(app);
		this.value = initial;
	}

	onOpen(): void {
		this.setTitle("Name this device");
		this.contentEl.createEl("p", {
			text: "Entries written on this device are attributed to this name. It also becomes part of trace file names, so it must differ from other devices.",
		});
		let errorEl: HTMLElement | null = null;
		new Setting(this.contentEl).setName("Device name").addText((text) => {
			text.setValue(this.value)
				.setPlaceholder("E.g. Laptop")
				.onChange((v) => {
					this.value = v;
					if (errorEl) errorEl.setText("");
				});
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					this.submit();
				}
			});
		});
		errorEl = this.contentEl.createEl("p", { cls: "trace-error" });
		new Setting(this.contentEl).addButton((btn) =>
			btn
				.setButtonText("Save")
				.setCta()
				.onClick(() => this.submit())
		);
		this.registerError = (msg) => errorEl?.setText(msg);
	}

	private registerError: (msg: string) => void = () => {
		// replaced in onOpen
	};

	private submit(): void {
		const error = checkNameAgainstActors(this.value, this.otherActors);
		if (error) {
			this.registerError(error);
			return;
		}
		this.close();
		this.onSubmit(this.value);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Identity recovery: local identity storage is empty but trace files exist.
 * Never silently mint a new identity in that situation — the user may be on
 * a restored/reinstalled device that owns some of those files.
 */
export class ReclaimIdentityModal extends Modal {
	constructor(
		app: App,
		private actors: TraceFileMeta[],
		private onReclaim: (meta: TraceFileMeta) => void,
		private onCreateNew: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Reconnect this device to a writer");
		this.contentEl.createEl("p", {
			text: "This device has no writer identity, but this vault contains trace files. If this device wrote some of them (for example after a reinstall), reclaim that writer so its traces stay owned. Otherwise create a new identity.",
		});
		for (const actor of this.actors) {
			new Setting(this.contentEl)
				.setName(actor.actorName)
				.setDesc(`Writer id ${actor.actorId}`)
				.addButton((btn) =>
					btn.setButtonText("Reclaim").onClick(() => {
						this.close();
						this.onReclaim(actor);
					})
				);
		}
		new Setting(this.contentEl)
			.setName("This is a new device")
			.addButton((btn) =>
				btn
					.setButtonText("Create new identity")
					.setCta()
					.onClick(() => {
						this.close();
						this.onCreateNew();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Convenience: notify when identity was created automatically. */
export function automaticIdentityNotice(identity: Identity): void {
	new Notice(
		`Trace will write as "${identity.actorName}". Rename it in Trace settings if you want.`
	);
}

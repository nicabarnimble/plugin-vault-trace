import { Modal, Notice, Setting, TFile } from "obsidian";
import {
	formatAttestationPayload,
	sha256Bytes,
	slugify,
	validateName,
} from "./format";
import type TracePlugin from "./main";

/** Modal for the main append path: pick a logical trace, write text,
 * optionally tag it. Appends always go to this device's own writer file. */
export class AppendEntryModal extends Modal {
	private traceSlug = "";
	private tag: string | null = null;
	private text = "";

	constructor(private plugin: TracePlugin, initialTraceSlug?: string) {
		super(plugin.app);
		if (initialTraceSlug) this.traceSlug = initialTraceSlug;
	}

	onOpen(): void {
		this.setTitle("Append entry");
		const traces = this.plugin.registry.logicalTraces();

		if (traces.length === 0) {
			this.contentEl.createEl("p", {
				text: "No traces exist yet. Create one first.",
			});
			new Setting(this.contentEl).addButton((btn) =>
				btn
					.setButtonText("Create timeline")
					.setCta()
					.onClick(() => {
						this.close();
						new CreateTraceModal(this.plugin).open();
					})
			);
			return;
		}

		if (!this.traceSlug || !traces.some((t) => t.slug === this.traceSlug)) {
			this.traceSlug = this.plugin.lastUsedTrace ?? traces[0].slug;
			if (!traces.some((t) => t.slug === this.traceSlug)) {
				this.traceSlug = traces[0].slug;
			}
		}

		new Setting(this.contentEl).setName("Trace").addDropdown((dropdown) => {
			for (const trace of traces) {
				dropdown.addOption(trace.slug, trace.name);
			}
			dropdown.setValue(this.traceSlug).onChange((value) => {
				this.traceSlug = value;
			});
		});

		new Setting(this.contentEl).setName("Tag").addDropdown((dropdown) => {
			dropdown.addOption("", "None");
			for (const tag of this.plugin.settings.tagSet) {
				dropdown.addOption(tag, "#" + tag);
			}
			dropdown.setValue(this.tag ?? "").onChange((value) => {
				this.tag = value === "" ? null : value;
			});
		});

		const textSetting = new Setting(this.contentEl)
			.setName("Text")
			.setClass("trace-append-text");
		textSetting.addTextArea((textArea) => {
			textArea.setPlaceholder("What happened?").onChange((value) => {
				this.text = value;
			});
			textArea.inputEl.rows = 4;
			textArea.inputEl.addEventListener("keydown", (event) => {
				if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
					event.preventDefault();
					void this.submit();
				}
			});
			window.setTimeout(() => textArea.inputEl.focus(), 0);
		});

		new Setting(this.contentEl).addButton((btn) =>
			btn
				.setButtonText("Append")
				.setCta()
				.onClick(() => void this.submit())
		);
	}

	private async submit(): Promise<void> {
		const text = this.text.trim();
		if (text.length === 0) {
			new Notice("Entry text can't be empty.");
			return;
		}
		const trace = this.plugin.registry
			.logicalTraces()
			.find((t) => t.slug === this.traceSlug);
		if (!trace) {
			new Notice("Pick a trace first.");
			return;
		}
		this.close();
		await this.plugin.appendToTrace(
			trace.slug,
			trace.name,
			this.tag ? "#" + this.tag : null,
			text
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Create a new logical trace: this device's writer file with genesis. */
export class RecordFileChangeModal extends Modal {
	private traceSlug = "";
	private change: "create" | "modify" = "modify";

	constructor(private plugin: TracePlugin, private file: TFile) {
		super(plugin.app);
	}

	onOpen(): void {
		this.setTitle("Record file change");
		const traces = this.plugin.registry.logicalTraces();
		if (traces.length === 0) {
			this.contentEl.createEl("p", {
				text: "No traces exist yet. Create one before recording a file change.",
			});
			return;
		}
		this.traceSlug = this.plugin.lastUsedTrace ?? traces[0].slug;
		if (!traces.some((trace) => trace.slug === this.traceSlug)) {
			this.traceSlug = traces[0].slug;
		}

		this.contentEl.createEl("p", {
			text: `This writes a #attest entry for ${this.file.path}.`,
		});
		new Setting(this.contentEl).setName("Trace").addDropdown((dropdown) => {
			for (const trace of traces) {
				dropdown.addOption(trace.slug, trace.name);
			}
			dropdown.setValue(this.traceSlug).onChange((value) => {
				this.traceSlug = value;
			});
		});
		new Setting(this.contentEl).setName("Change").addDropdown((dropdown) => {
			dropdown
				.addOption("modify", "Modify")
				.addOption("create", "Create")
				.setValue(this.change)
				.onChange((value) => {
					this.change = value === "create" ? "create" : "modify";
				});
		});
		new Setting(this.contentEl).addButton((btn) =>
			btn
				.setButtonText("Record")
				.setCta()
				.onClick(() => void this.submit())
		);
	}

	private async submit(): Promise<void> {
		const trace = this.plugin.registry
			.logicalTraces()
			.find((t) => t.slug === this.traceSlug);
		if (!trace) {
			new Notice("Pick a trace first.");
			return;
		}
		try {
			const bytes = await this.plugin.app.vault.readBinary(this.file);
			const sha256 = await sha256Bytes(bytes);
			const payload = formatAttestationPayload({
				change: this.change,
				path: this.file.path,
				sha256,
			});
			this.close();
			await this.plugin.appendToTrace(trace.slug, trace.name, "#attest", payload);
		} catch (error) {
			new Notice(
				`Attestation failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class CreateTraceModal extends Modal {
	private name = "";

	constructor(private plugin: TracePlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		this.setTitle("Create timeline");
		this.contentEl.createEl("p", {
			text: "A trace is a shared timeline. Each device appends to its own file inside it.",
		});
		new Setting(this.contentEl).setName("Trace name").addText((text) => {
			text.setPlaceholder("E.g. Project log").onChange((value) => {
				this.name = value;
			});
			text.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					void this.submit();
				}
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});
		new Setting(this.contentEl).addButton((btn) =>
			btn
				.setButtonText("Create")
				.setCta()
				.onClick(() => void this.submit())
		);
	}

	private async submit(): Promise<void> {
		const name = this.name.trim();
		const invalid = validateName(name);
		if (invalid) {
			new Notice(invalid);
			return;
		}
		const slug = slugify(name);
		const existing = this.plugin.registry
			.logicalTraces()
			.find((t) => t.slug === slug);
		if (existing && existing.name !== name) {
			new Notice(
				`"${name}" collides with existing trace "${existing.name}" (both become "${slug}"). Pick a different name.`
			);
			return;
		}
		this.close();
		await this.plugin.createTrace(name, slug);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

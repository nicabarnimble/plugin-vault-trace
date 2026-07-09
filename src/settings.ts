import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_TEMPLATE, RESERVED_TAGS, validateTemplate } from "./format";
import { checkNameAgainstActors } from "./identity";
import type TracePlugin from "./main";

export type EnforcementMode = "enforce" | "warn";
export type RotationMode = "auto" | "never";

export interface TraceSettings {
	/** Folder where trace files live and new writer files are created. */
	tracesFolder: string;
	/** Extra file paths treated as traces even outside the folder. */
	explicitPaths: string[];
	/** Treat any file with `trace: true` frontmatter as a trace. */
	useFrontmatterFlag: boolean;
	enforcementMode: EnforcementMode;
	/** Reading-view decoration; file bytes always stay canonical. */
	displayTemplate: string;
	/** Tag tokens (without #) offered in the append dialog. */
	tagSet: string[];
	/** CodeMirror read-only protection for trace files. */
	readOnlyGuard: boolean;
	/** Segment rotation policy for writer files. */
	rotationMode: RotationMode;
	/** Rotate when the active writer file reaches this many bytes. */
	rotationMaxBytes: number;
	/** Rotate when the active writer file is this old. */
	rotationMaxAgeDays: number;
}

export const DEFAULT_SETTINGS: TraceSettings = {
	tracesFolder: "Traces",
	explicitPaths: [],
	useFrontmatterFlag: true,
	enforcementMode: "enforce",
	displayTemplate: DEFAULT_TEMPLATE,
	tagSet: ["note", "agent", "decision", "milestone"],
	readOnlyGuard: true,
	rotationMode: "auto",
	rotationMaxBytes: 1_000_000,
	rotationMaxAgeDays: 365,
};

const TAG_TOKEN_RE = /^[a-z0-9][a-z0-9_-]*$/;

export class TraceSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: TracePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const identity = this.plugin.identity.get();
		new Setting(containerEl)
			.setName("This device's name")
			.setDesc(
				identity
					? `Entries from this device are attributed to "${identity.actorName}" (file segment "${identity.actorSlug}"). Existing owned files continue to receive appends after a rename; new writer files use the new name.`
					: "Trace creates an automatic device name on first use. Set a custom name only if you want one."
			)
			.addButton((btn) =>
				btn
					.setButtonText(identity ? "Rename" : "Set custom name")
					.onClick(() => this.plugin.promptDeviceName(() => this.display()))
			);

		new Setting(containerEl)
			.setName("Traces folder")
			.setDesc("Folder that holds trace files; new traces are created here.")
			.addText((text) =>
				text
					.setPlaceholder("Traces")
					.setValue(this.plugin.settings.tracesFolder)
					.onChange(async (value) => {
						this.plugin.settings.tracesFolder =
							value.replace(/^\/+|\/+$/g, "") || "Traces";
						await this.plugin.saveSettings();
						this.plugin.registry.rebuild();
					})
			);

		new Setting(containerEl)
			.setName("Rotation")
			.setDesc(
				"Auto starts a new segment when this writer's file reaches the size or age limit. Never keeps one file per writer."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("auto", "Auto")
					.addOption("never", "Never")
					.setValue(this.plugin.settings.rotationMode)
					.onChange(async (value) => {
						this.plugin.settings.rotationMode = value === "never" ? "never" : "auto";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max segment size")
			.setDesc("Auto-rotation size limit in megabytes. Default: 1 megabyte.")
			.addText((text) =>
				text
					.setPlaceholder("1")
					.setValue(String(this.plugin.settings.rotationMaxBytes / 1_000_000))
					.onChange(async (value) => {
						const mb = Number(value.trim());
						if (!Number.isFinite(mb) || mb <= 0) {
							new Notice("Max segment size must be a positive number.");
							return;
						}
						this.plugin.settings.rotationMaxBytes = Math.round(mb * 1_000_000);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max segment age")
			.setDesc("Auto-rotation age limit in days. Default: 365 days.")
			.addText((text) =>
				text
					.setPlaceholder("365")
					.setValue(String(this.plugin.settings.rotationMaxAgeDays))
					.onChange(async (value) => {
						const days = Number(value.trim());
						if (!Number.isFinite(days) || days <= 0) {
							new Notice("Max segment age must be a positive number of days.");
							return;
						}
						this.plugin.settings.rotationMaxAgeDays = Math.round(days);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Additional trace paths")
			.setDesc("Files outside the folder to treat as traces, one path per line.")
			.addTextArea((text) =>
				text
					.setPlaceholder("Logs/deploys.laptop.md")
					.setValue(this.plugin.settings.explicitPaths.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.explicitPaths = value
							.split("\n")
							.map((line) => line.trim())
							.filter((line) => line.length > 0);
						await this.plugin.saveSettings();
						this.plugin.registry.rebuild();
					})
			);

		new Setting(containerEl)
			.setName("Detect traces by frontmatter")
			.setDesc("Treat any note with `trace: true` frontmatter as a trace file.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useFrontmatterFlag)
					.onChange(async (value) => {
						this.plugin.settings.useFrontmatterFlag = value;
						await this.plugin.saveSettings();
						this.plugin.registry.rebuild();
					})
			);

		new Setting(containerEl)
			.setName("Enforcement mode")
			.setDesc(
				"Enforce reverts non-append changes to this device's own files; warn only notifies. Other writers' files are never reverted either way."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("enforce", "Enforce (revert and notify)")
					.addOption("warn", "Warn only")
					.setValue(this.plugin.settings.enforcementMode)
					.onChange(async (value) => {
						this.plugin.settings.enforcementMode =
							value === "warn" ? "warn" : "enforce";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Read-only guard in the editor")
			.setDesc(
				"Block edits to committed entries in the editor. Off still leaves the modify-time protection active."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.readOnlyGuard)
					.onChange(async (value) => {
						this.plugin.settings.readOnlyGuard = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Display template")
			.setDesc(
				"Decoration for reading view only — files always keep the canonical format. All placeholders required, in order: {{seq}} {{timestamp}} {{actor}} {{tag}} {{text}} {{hash}}."
			)
			.addTextArea((text) =>
				text
					.setValue(this.plugin.settings.displayTemplate)
					.onChange(async (value) => {
						const error = validateTemplate(value);
						if (error) {
							new Notice(`Template not saved: ${error}`);
							return;
						}
						this.plugin.settings.displayTemplate = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Tags")
			.setDesc(
				"Tags offered when appending, comma-separated, lowercase letters/digits/-/_ (no #). Reserved protocol tags are not allowed."
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.tagSet.join(", "))
					.onChange(async (value) => {
						const tokens = value
							.split(",")
							.map((t) => t.trim().replace(/^#/, ""))
							.filter((t) => t.length > 0);
						const bad = tokens.filter((t) => !TAG_TOKEN_RE.test(t));
						if (bad.length > 0) {
							new Notice(`Invalid tag${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}`);
							return;
						}
						const reserved = tokens.filter((t) =>
							(RESERVED_TAGS as readonly string[]).includes("#" + t)
						);
						if (reserved.length > 0) {
							new Notice(`Reserved tag${reserved.length > 1 ? "s" : ""}: ${reserved.join(", ")}`);
							return;
						}
						this.plugin.settings.tagSet = tokens;
						await this.plugin.saveSettings();
					})
			);
	}
}

export { checkNameAgainstActors };

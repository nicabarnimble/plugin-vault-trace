type Callback = () => void;

class MockElement {
	textContent = "";
	rows = 0;

	empty(): void {
		this.textContent = "";
	}

	addClass(): void {
		// test mock
	}

	setText(text: string): void {
		this.textContent = text;
	}

	createEl(_tag: string, options?: { text?: string; cls?: string }): MockElement {
		const child = new MockElement();
		if (options?.text) child.textContent = options.text;
		return child;
	}

	createDiv(_options?: { cls?: string }): MockElement {
		return new MockElement();
	}

	createSpan(options?: { text?: string; cls?: string }): MockElement {
		const child = new MockElement();
		if (options?.text) child.textContent = options.text;
		return child;
	}

	querySelectorAll(): MockElement[] {
		return [];
	}

	addEventListener(): void {
		// test mock
	}
}

export class Notice {
	constructor(public message: string, public timeout?: number) {}
}

export class TFile {
	constructor(public path = "", public name = path.split("/").pop() ?? path) {}
}

export class TFolder {
	constructor(public path = "") {}
}

export class Vault {
	getMarkdownFiles(): TFile[] {
		return [];
	}
}

export class App {
	vault = new Vault();
	workspace = {
		getActiveFile: (): TFile | null => null,
	};
	metadataCache = {
		getFileCache: (): { frontmatter?: Record<string, unknown> } | null => null,
	};

	loadLocalStorage(): unknown {
		return null;
	}

	saveLocalStorage(): void {
		// test mock
	}
}

export class Modal {
	contentEl = new MockElement();

	constructor(public app: App) {}

	setTitle(): void {
		// test mock
	}

	open(): void {
		this.onOpen();
	}

	close(): void {
		this.onClose();
	}

	onOpen(): void {
		// overridden by subclasses
	}

	onClose(): void {
		// overridden by subclasses
	}
}

class TextComponent {
	inputEl = new MockElement();

	setPlaceholder(): this {
		return this;
	}

	setValue(): this {
		return this;
	}

	onChange(): this {
		return this;
	}
}

class TextAreaComponent extends TextComponent {}

class ButtonComponent {
	setButtonText(): this {
		return this;
	}

	setCta(): this {
		return this;
	}

	setWarning(): this {
		return this;
	}

	onClick(): this {
		return this;
	}
}

class DropdownComponent {
	addOption(): this {
		return this;
	}

	setValue(): this {
		return this;
	}

	onChange(): this {
		return this;
	}
}

class ToggleComponent {
	setValue(): this {
		return this;
	}

	onChange(): this {
		return this;
	}
}

export class Setting {
	constructor(public containerEl: MockElement) {}

	setName(): this {
		return this;
	}

	setDesc(): this {
		return this;
	}

	setClass(): this {
		return this;
	}

	addButton(callback: (button: ButtonComponent) => void): this {
		callback(new ButtonComponent());
		return this;
	}

	addText(callback: (text: TextComponent) => void): this {
		callback(new TextComponent());
		return this;
	}

	addTextArea(callback: (text: TextAreaComponent) => void): this {
		callback(new TextAreaComponent());
		return this;
	}

	addDropdown(callback: (dropdown: DropdownComponent) => void): this {
		callback(new DropdownComponent());
		return this;
	}

	addToggle(callback: (toggle: ToggleComponent) => void): this {
		callback(new ToggleComponent());
		return this;
	}
}

export class Plugin {
	app = new App();
}

export class PluginSettingTab {
	containerEl = new MockElement();

	constructor(public app: App, public plugin: Plugin) {}

	display(): void {
		// overridden by subclasses
	}
}

export function debounce<T extends Callback>(callback: T): T {
	return callback;
}

export const editorInfoField = Symbol("editorInfoField");

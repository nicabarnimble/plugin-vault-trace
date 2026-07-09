import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { IdentityManager, checkNameAgainstActors } from "../src/identity";
import {
	GENESIS,
	computeEntryHash,
	formatEntryLine,
	renderTemplate,
	slugify,
	validateTemplate,
	type EntryFields,
} from "../src/format";
import {
	classifyChange,
	protectedEndOffset,
	validateAppendedTail,
} from "../src/guard";

async function entry(seq: number, text: string, prev = GENESIS): Promise<{ line: string; hash: string; fields: EntryFields }> {
	const fields: EntryFields = {
		seq,
		timestamp: `2026-07-08T10:0${seq}:00Z`,
		actor: "Laptop",
		tag: seq === 1 ? "#genesis" : "#note",
		text,
	};
	const hash = await computeEntryHash(prev, fields);
	return { line: formatEntryLine(fields, hash), hash, fields };
}

describe("edit guard pure helpers", () => {
	it("classifies strict prefix growth as append and rewrites as violations", () => {
		expect(classifyChange("abc", "abc")).toEqual({ kind: "unchanged" });
		expect(classifyChange("abc", "abcdef")).toEqual({ kind: "append", tail: "def" });
		expect(classifyChange("abc", "abX")).toEqual({ kind: "rewrite" });
	});

	it("protects frontmatter and committed entry lines", async () => {
		const one = await entry(1, "Genesis");
		const doc = `---\ntrace: true\n---\n${one.line}\n\neditable tail`;
		expect(protectedEndOffset(doc)).toBe(doc.indexOf("\n\neditable tail") + 1);
	});

	it("validates appended tails against actor, sequence, and hash", async () => {
		const first = await entry(1, "Genesis");
		const second = await entry(2, "Second", first.hash);
		await expect(validateAppendedTail(second.line + "\n", 1, first.hash, "Laptop")).resolves.toMatchObject({ ok: true, seq: 2 });
		const mismatch = await validateAppendedTail(second.line + "\n", 1, first.hash, "Phone");
		expect(mismatch.ok).toBe(false);
		expect(mismatch.reason).toContain("does not match");
	});
});

describe("format and identity helpers", () => {
	it("renders display templates without changing canonical fields", () => {
		const error = validateTemplate("{{seq}} · {{timestamp}} · {{actor}} · {{tag}} · {{text}} · {{hash}}");
		expect(error).toBeNull();
		expect(validateTemplate("{{text}} {{seq}} {{timestamp}} {{actor}} {{tag}} {{hash}}")).toContain("out of order");
		expect(
			renderTemplate("{{seq}} {{actor}} {{tag}} {{text}} {{hash}}", {
				seq: 2,
				timestamp: "2026-07-08T10:02:00Z",
				actor: "Laptop",
				tag: "#note",
				text: "Done",
				escapedText: "Done",
				anchor: "12345678",
				line: 2,
			})
		).toBe("2 Laptop #note Done #12345678");
	});

	it("slugifies unsafe names and rejects actor slug collisions", () => {
		expect(slugify("My Laptop: Main")).toBe("my-laptop-main");
		expect(
			checkNameAgainstActors("my laptop main", [
				{ actorSlug: "my-laptop-main", actorName: "My Laptop: Main" },
			])
		).toContain("already taken");
	});

	it("creates an automatic device identity without requiring a custom name", () => {
		let stored: unknown = null;
		const manager = new IdentityManager({
			loadLocalStorage: () => stored,
			saveLocalStorage: (_key: string, value: unknown) => {
				stored = value;
			},
		} as unknown as App);
		const identity = manager.createDefault();
		expect(identity.actorName).toMatch(/^Device [0-9a-f]{8}$/);
		expect(identity.actorSlug).toMatch(/^device-[0-9a-f]{8}$/);
		expect(manager.load()).toEqual(identity);
	});
});

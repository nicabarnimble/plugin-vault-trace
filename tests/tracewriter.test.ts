import { TFile, type App } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GENESIS,
	appendEntry as referenceAppendEntry,
	computeEntryHash,
	formatEntryLine,
	sha256Hex,
	type EntryFields,
} from "../reference/parser";
import type { TraceFileMeta } from "../src/format";
import { ChainStore, TraceWriter } from "../src/hashchain";

const PATH = "Traces/project-log.laptop.md";
const META: TraceFileMeta = {
	traceName: "Project log",
	traceSlug: "project-log",
	actorName: "Laptop",
	actorSlug: "laptop",
	actorId: "actor-1",
};

function frontmatter(): string {
	return [
		"---",
		"trace: true",
		"format: tracev1",
		"trace_name: Project log",
		"trace_slug: project-log",
		"actor_name: Laptop",
		"actor_slug: laptop",
		"actor_id: actor-1",
		"---",
	].join("\n") + "\n";
}

function makeFile(path: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split("/").pop() ?? path;
	return file;
}

async function baseTrace(): Promise<string> {
	const fields: EntryFields = {
		seq: 1,
		timestamp: "2026-07-08T10:00:00Z",
		actor: "Laptop",
		tag: "#genesis",
		text: "Trace started by Laptop",
	};
	const hash = await computeEntryHash(GENESIS, fields);
	return frontmatter() + formatEntryLine(fields, hash) + "\n";
}

class MemoryVault {
	content = new Map<string, string>();

	async read(file: TFile): Promise<string> {
		const content = this.content.get(file.path);
		if (content === undefined) throw new Error(`Missing file ${file.path}`);
		return content;
	}

	async append(file: TFile, data: string): Promise<void> {
		const content = await this.read(file);
		this.content.set(file.path, content + data);
	}

	getAbstractFileByPath(path: string): TFile | null {
		return this.content.has(path) ? makeFile(path) : null;
	}
}

afterEach(() => {
	vi.useRealTimers();
});

describe("TraceWriter", () => {
	it("appends byte-identical content to the standalone reference appendEntry", async () => {
		const base = await baseTrace();
		const vault = new MemoryVault();
		vault.content.set(PATH, base);
		const chain = new ChainStore(async () => undefined);
		const selfWrites: string[] = [];
		const cache = new Map<string, string>();
		const writer = new TraceWriter({
			app: { vault } as unknown as App,
			chain,
			markSelfWrite: (path) => selfWrites.push(path),
			setCache: (path, content) => cache.set(path, content),
		});

		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-08T10:02:00Z"));
		const file = makeFile(PATH);
		const appended = await writer.appendEntry(file, META, {
			tag: "#note",
			text: "Manual append",
		});
		const expected = await referenceAppendEntry(base, {
			actor: "Laptop",
			tag: "#note",
			text: "Manual append",
			timestamp: "2026-07-08T10:02:00Z",
		});

		expect(vault.content.get(PATH)).toBe(expected);
		expect(cache.get(PATH)).toBe(expected);
		expect(selfWrites).toEqual([PATH]);
		expect(appended.line + "\n").toBe(expected.slice(base.length));
		expect(chain.get(PATH)).toMatchObject({
			seq: 2,
			entryCount: 2,
			contentSha: await sha256Hex(expected),
		});
	});
});

import { describe, expect, it } from "vitest";
import {
	GENESIS,
	appendEntry,
	computeEntryHash,
	formatAttestationPayload,
	formatEntryLine,
	formatRotationPayload,
	headOf,
	mergeTimelines,
	parseAttestationPayload,
	parseEntryLine,
	parseRotationPayload,
	parseTrace,
	verifyProgression,
	verifyTrace,
	type EntryFields,
} from "../reference/parser";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function must<T>(value: T | null | undefined, label: string): T {
	if (value === null || value === undefined) throw new Error(`${label} missing`);
	return value;
}

function frontmatter(actor = "Laptop"): string {
	return [
		"---",
		"trace: true",
		"format: tracev1",
		"trace_name: Project log",
		"trace_slug: project-log",
		`actor_name: ${actor}`,
		`actor_slug: ${actor.toLowerCase()}`,
		"actor_id: actor-1",
		"---",
	].join("\n") + "\n";
}

async function traceFrom(fields: Omit<EntryFields, "seq">[], actor = "Laptop"): Promise<string> {
	let head = GENESIS;
	const lines: string[] = [];
	for (let i = 0; i < fields.length; i++) {
		const entry: EntryFields = { ...fields[i], seq: i + 1 };
		head = await computeEntryHash(head, entry);
		lines.push(formatEntryLine(entry, head));
	}
	return frontmatter(actor) + lines.join("\n") + "\n";
}

async function genesisOnly(actor = "Laptop"): Promise<string> {
	return traceFrom([
		{
			timestamp: "2026-07-08T10:00:00Z",
			actor,
			tag: "#genesis",
			text: `Trace started by ${actor}`,
		},
	], actor);
}

describe("tracev1 grammar and hashing", () => {
	it("round-trips escaped entry text through parse and serialize", async () => {
		const fields: EntryFields = {
			seq: 1,
			timestamp: "2026-07-08T10:00:00Z",
			actor: "Laptop",
			tag: "#note",
			text: "line one\npipe | slash \\",
		};
		const hash = await computeEntryHash(GENESIS, fields);
		const line = formatEntryLine(fields, hash);
		const parsed = parseEntryLine(line, 1);
		expect(parsed?.text).toBe(fields.text);
		expect(parsed?.tag).toBe("#note");
		expect(formatEntryLine(fields, hash)).toBe(line);
	});

	it("verifies a valid chain and pinpoints a tampered entry", async () => {
		const text = await traceFrom([
			{
				timestamp: "2026-07-08T10:00:00Z",
				actor: "Laptop",
				tag: "#genesis",
				text: "Trace started by Laptop",
			},
			{
				timestamp: "2026-07-08T10:01:00Z",
				actor: "Laptop",
				tag: "#note",
				text: "Second entry",
			},
		]);
		await expect(verifyTrace(text)).resolves.toMatchObject({ ok: true, entryCount: 2 });

		const tampered = text.replace("Second entry", "Changed entry");
		const result = await verifyTrace(tampered);
		expect(result.ok).toBe(false);
		expect(result.issues.some((issue) => issue.code === "HASH_MISMATCH" && issue.seq === 2)).toBe(true);
	});

	it("reports a sequence gap when an entry is removed", async () => {
		const text = await traceFrom([
			{
				timestamp: "2026-07-08T10:00:00Z",
				actor: "Laptop",
				tag: "#genesis",
				text: "Trace started by Laptop",
			},
			{
				timestamp: "2026-07-08T10:01:00Z",
				actor: "Laptop",
				tag: "#note",
				text: "Middle entry",
			},
			{
				timestamp: "2026-07-08T10:02:00Z",
				actor: "Laptop",
				tag: "#note",
				text: "Last entry",
			},
		]);
		const lines = text.split("\n");
		const removedMiddle = lines.filter((line) => !line.includes("Middle entry")).join("\n");
		const result = await verifyTrace(removedMiddle);
		expect(result.issues.some((issue) => issue.code === "SEQ_GAP" && issue.seq === 3)).toBe(true);
	});
});

describe("attestation convention", () => {
	it("serializes and parses deterministic #attest payloads", () => {
		const payload = formatAttestationPayload({
			change: "modify",
			path: "Projects/Plan A.md",
			sha256: SHA_A,
		});
		expect(payload).toBe(`path=Projects/Plan%20A.md change=modify sha256=${SHA_A}`);
		expect(parseAttestationPayload(payload)).toEqual({
			ok: true,
			payload: { change: "modify", path: "Projects/Plan A.md", sha256: SHA_A },
		});

		const rename = formatAttestationPayload({
			change: "rename",
			from: "Old name.md",
			to: "New name.md",
			sha256: SHA_B,
		});
		expect(rename).toBe(`from=Old%20name.md to=New%20name.md change=rename sha256=${SHA_B}`);
		expect(parseAttestationPayload(`path=Projects/Plan%20A.md sha256=${SHA_A} change=modify`)).toMatchObject({
			ok: false,
		});
	});

	it("serializes and parses #rotate payloads", () => {
		const payload = formatRotationPayload({
			previous: "Traces/project-log/0001-2026-07.laptop.md",
			previousSeq: 123,
			previousHead: SHA_B,
		});
		expect(payload).toBe(`previous=Traces/project-log/0001-2026-07.laptop.md previous_seq=123 previous_head=${SHA_B}`);
		expect(parseRotationPayload(payload)).toEqual({
			ok: true,
			payload: {
				previous: "Traces/project-log/0001-2026-07.laptop.md",
				previousSeq: 123,
				previousHead: SHA_B,
			},
		});
		expect(parseRotationPayload(`previous=x previous_head=${SHA_B} previous_seq=123`)).toMatchObject({ ok: false });
	});

	it("reports malformed #attest payloads without failing the chain", async () => {
		const text = await traceFrom([
			{
				timestamp: "2026-07-08T10:00:00Z",
				actor: "Laptop",
				tag: "#genesis",
				text: "Trace started by Laptop",
			},
			{
				timestamp: "2026-07-08T10:01:00Z",
				actor: "Laptop",
				tag: "#attest",
				text: "path=Projects/plan.md change=modify sha256=bad",
			},
		]);
		const parsed = parseTrace(text);
		expect(parsed.conventionIssues).toHaveLength(1);
		const verified = await verifyTrace(text);
		expect(verified.ok).toBe(true);
		expect(verified.conventionIssues).toHaveLength(1);
	});
});

describe("external append and supervisor heads", () => {
	it("appendEntry emits the same canonical bytes as the plugin append path", async () => {
		const base = await genesisOnly();
		const timestamp = "2026-07-08T10:02:00Z";
		const appended = await appendEntry(base, {
			actor: "Laptop",
			tag: "#note",
			text: "Manual append",
			timestamp,
		});

		const head = await headOf(base);
		expect(head).not.toBeNull();
		const fields: EntryFields = {
			seq: 2,
			timestamp,
			actor: "Laptop",
			tag: "#note",
			text: "Manual append",
		};
		const hash = await computeEntryHash(must(head, "head").hash, fields);
		expect(appended).toBe(base + formatEntryLine(fields, hash) + "\n");
	});

	it("verifyProgression accepts append-only growth", async () => {
		const base = await genesisOnly();
		const oldHead = await headOf(base);
		const grown = await appendEntry(base, {
			actor: "Laptop",
			tag: "#note",
			text: "Next",
			timestamp: "2026-07-08T10:02:00Z",
		});
		const result = await verifyProgression(must(oldHead, "old head"), grown);
		expect(result.ok).toBe(true);
		expect(result.currentHead?.seq).toBe(2);
	});

	it("verifyProgression distinguishes rewritten history, tampered tails, and gaps", async () => {
		const original = await appendEntry(await genesisOnly(), {
			actor: "Laptop",
			tag: "#note",
			text: "Original",
			timestamp: "2026-07-08T10:02:00Z",
		});
		const oldHead = await headOf(original);
		const rewritten = await appendEntry(await genesisOnly(), {
			actor: "Laptop",
			tag: "#note",
			text: "Rewritten",
			timestamp: "2026-07-08T10:02:00Z",
		});
		expect((await verifyProgression(must(oldHead, "old head"), rewritten)).status).toBe("head-not-found");

		const genesis = await genesisOnly();
		const genesisHead = await headOf(genesis);
		const grown = await appendEntry(genesis, {
			actor: "Laptop",
			tag: "#note",
			text: "Tail",
			timestamp: "2026-07-08T10:02:00Z",
		});
		expect((await verifyProgression(must(genesisHead, "genesis head"), grown.replace("Tail", "Tale"))).status).toBe("chain-invalid");

		const first = parseTrace(genesis).entries[0];
		let head = must(genesisHead, "genesis head").hash;
		const seq3: EntryFields = {
			seq: 3,
			timestamp: "2026-07-08T10:03:00Z",
			actor: "Laptop",
			tag: "#note",
			text: "Gap after head",
		};
		head = await computeEntryHash(head, seq3);
		const gapFile = frontmatter() + formatEntryLine(first, must(genesisHead, "genesis head").hash) + "\n" + formatEntryLine(seq3, head) + "\n";
		expect((await verifyProgression(must(genesisHead, "genesis head"), gapFile)).status).toBe("gap");
	});
});

describe("timeline merge", () => {
	it("merges writer files by timestamp and preserves anchors", async () => {
		const laptop = await traceFrom([
			{
				timestamp: "2026-07-08T10:00:00Z",
				actor: "Laptop",
				tag: "#genesis",
				text: "Trace started by Laptop",
			},
		], "Laptop");
		const phone = await traceFrom([
			{
				timestamp: "2026-07-08T09:59:00Z",
				actor: "Phone",
				tag: "#genesis",
				text: "Trace started by Phone",
			},
		], "Phone");
		const merged = mergeTimelines([
			{ actor: "Laptop", text: laptop },
			{ actor: "Phone", text: phone },
		]);
		expect(merged.timeline.map((item) => item.actor)).toEqual(["Phone", "Laptop"]);
		expect(merged.timeline[0].anchor).toMatch(/^#[0-9a-f]{8}$/);
	});
});

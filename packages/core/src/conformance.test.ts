import { describe, expect, it } from "vitest";
import suite from "../../../conformance/task-envelopes.json";
import { encodeTaskEnvelope, parseTaskEnvelope } from "./task";

describe("task-envelope conformance vectors", () => {
	it("uses a versioned document with unique IDs and complete expectations", () => {
		expect(suite.formatVersion).toBe(1);
		expect(new Set(suite.vectors.map((vector) => vector.id)).size).toBe(
			suite.vectors.length,
		);
		for (const vector of suite.vectors) {
			expect(vector.spec).toBe("packages/core/SPEC.md#task-lifecycle");
			if (vector.valid) {
				expect(vector).toHaveProperty("envelope");
			}
		}
	});

	it("covers every envelope type, every res status and both valid and invalid vectors", () => {
		const valid = suite.vectors.filter((vector) => vector.valid);
		const types = new Set(valid.map((vector) => vector.envelope?.t));
		expect([...types].sort()).toEqual(["cancel", "input", "req", "res"]);
		const statuses = new Set(
			valid
				.filter((vector) => vector.envelope?.t === "res")
				.map((vector) => (vector.envelope as { status?: string }).status),
		);
		expect([...statuses].sort()).toEqual([
			"completed",
			"failed",
			"input-required",
		]);
		expect(valid.length).toBeGreaterThan(0);
		expect(suite.vectors.length - valid.length).toBeGreaterThan(0);
		expect(suite.vectors.length).toBeGreaterThanOrEqual(16);
	});

	const ran = new Set<string>();
	for (const vector of suite.vectors) {
		it(vector.id, () => {
			expect.hasAssertions();
			ran.add(vector.id);
			const parsed = parseTaskEnvelope(vector.text);
			if (!vector.valid) {
				expect(parsed).toBeNull();
				return;
			}
			expect(parsed).toEqual(vector.envelope);
			expect(JSON.parse(encodeTaskEnvelope(parsed!))).toEqual(vector.envelope);
		});
	}

	it("ran every vector in the document", () => {
		expect([...ran].sort()).toEqual(suite.vectors.map((v) => v.id).sort());
	});
});

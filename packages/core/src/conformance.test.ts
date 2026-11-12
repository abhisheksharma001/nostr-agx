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

	for (const vector of suite.vectors) {
		it(vector.id, () => {
			const parsed = parseTaskEnvelope(vector.text);
			if (!vector.valid) {
				expect(parsed).toBeNull();
				return;
			}
			expect(parsed).toEqual(vector.envelope);
			expect(JSON.parse(encodeTaskEnvelope(parsed!))).toEqual(vector.envelope);
		});
	}
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandbox } from "../../test/helpers.js";
import { ApiError } from "./http.js";
import {
	MAX_IDEMPOTENCY_KEY_CHARS,
	parseIdempotencyKey,
	TASK_IDEMPOTENCY_RETENTION_MS,
	TaskIdempotencyStore,
} from "./idempotency.js";

let box: ReturnType<typeof sandbox>;

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	box.restore();
});

describe("parseIdempotencyKey", () => {
	it("accepts a visible ASCII key and rejects missing, empty, long or whitespace keys", () => {
		expect(parseIdempotencyKey(undefined)).toBeNull();
		expect(parseIdempotencyKey("request-123:_~")).toBe("request-123:_~");
		for (const value of ["", "has space", "x".repeat(MAX_IDEMPOTENCY_KEY_CHARS + 1)]) {
			expect(() => parseIdempotencyKey(value)).toThrowError(
				expect.objectContaining({ status: 400, code: "invalid_idempotency_key" }),
			);
		}
	});
});

describe("TaskIdempotencyStore", () => {
	it("shares concurrent work and replays a canonically identical completed request", async () => {
		const store = new TaskIdempotencyStore("test");
		let runs = 0;
		let release: (() => void) | undefined;
		const operation = async () => {
			runs += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { status: "completed", output: { run: runs } };
		};
		const first = store.execute("credential-a", "key-1", { b: 2, a: 1 }, operation);
		const second = store.execute("credential-a", "key-1", { a: 1, b: 2 }, operation);
		expect(runs).toBe(1);
		release?.();
		await expect(first).resolves.toEqual({ status: "completed", output: { run: 1 } });
		await expect(second).resolves.toEqual({ status: "completed", output: { run: 1 } });
		await expect(store.execute("credential-a", "key-1", { a: 1, b: 2 }, operation)).resolves.toEqual({
			status: "completed",
			output: { run: 1 },
		});
		expect(runs).toBe(1);
		await expect(store.execute("credential-a", "key-1", { a: 1, b: 3 }, operation)).rejects.toMatchObject({
			status: 409,
			code: "idempotency_key_reused",
		});
		expect(runs).toBe(1);
	});

	it("replays a public task failure without executing again", async () => {
		const store = new TaskIdempotencyStore("test");
		let runs = 0;
		const operation = async (): Promise<Record<string, unknown>> => {
			runs += 1;
			throw new ApiError(502, "task_failed", "The peer reported failure", "Try again later.");
		};
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(store.execute("credential-a", "key-1", {}, operation)).rejects.toMatchObject({
				status: 502,
				code: "task_failed",
				message: "The peer reported failure",
				description: "Try again later.",
			});
		}
		expect(runs).toBe(1);
	});

	it("scopes a key to its credential", async () => {
		const store = new TaskIdempotencyStore("test");
		let runs = 0;
		const operation = async () => ({ run: ++runs });
		await expect(store.execute("credential-a", "shared-key", {}, operation)).resolves.toEqual({ run: 1 });
		await expect(store.execute("credential-b", "shared-key", {}, operation)).resolves.toEqual({ run: 2 });
		expect(runs).toBe(2);
	});

	it("restores completed outcomes and makes unresolved work explicitly unknown", async () => {
		const completed = new TaskIdempotencyStore("test");
		await completed.execute("credential-a", "completed", {}, async () => ({ status: "completed", output: { ok: true } }));
		completed.close();
		const restored = new TaskIdempotencyStore("test");
		await expect(
			restored.execute("credential-a", "completed", {}, async () => {
				throw new Error("must not execute");
			}),
		).resolves.toEqual({ status: "completed", output: { ok: true } });

		let release: (() => void) | undefined;
		const pending = restored.execute("credential-a", "pending", {}, async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { status: "completed" };
		});
		restored.close();
		const restarted = new TaskIdempotencyStore("test");
		await expect(restarted.execute("credential-a", "pending", {}, async () => ({ rerun: true }))).rejects.toMatchObject({
			status: 409,
			code: "result_unknown",
		});
		release?.();
		await expect(pending).resolves.toEqual({ status: "completed" });
		restarted.close();
	});

	it("expires retained outcomes", async () => {
		let now = 1_000_000;
		const store = new TaskIdempotencyStore("test", {
			now: () => now,
			retentionMs: TASK_IDEMPOTENCY_RETENTION_MS,
		});
		let runs = 0;
		const operation = async () => ({ run: ++runs });
		await store.execute("credential-a", "key-1", {}, operation);
		now += TASK_IDEMPOTENCY_RETENTION_MS + 1;
		await expect(store.execute("credential-a", "key-1", {}, operation)).resolves.toEqual({ run: 2 });
		expect(runs).toBe(2);
		store.close();
	});
});

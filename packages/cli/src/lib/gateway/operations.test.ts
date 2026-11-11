import { AgxPendingRequestStoreError, AgxRequestUnknownError } from "@nostr-agx/core";
import { describe, expect, it } from "vitest";
import { type OperationDeps, runRecoveredTaskRequest, runTaskRequest } from "./operations.js";

const PEER = "b".repeat(64);

function failingDeps(error: Error): OperationDeps {
	return {
		npub: "npub1gateway",
		requester: { request: () => Promise.reject(error) },
	} as unknown as OperationDeps;
}

async function recoveredFailure(error: Error): Promise<unknown> {
	const result = Promise.reject(error);
	result.catch(() => undefined);
	return runRecoveredTaskRequest(failingDeps(error), { taskId: "task-1", peer: PEER, capability: "x.y", result }).catch(
		(caught: unknown) => caught,
	);
}

async function taskFailure(error: Error): Promise<unknown> {
	return runTaskRequest(failingDeps(error), {
		peer: PEER,
		npub: "npub1peer",
		capability: "x.y",
		payload: {},
		timeoutSec: 30,
		checkCard: false,
		background: false,
	}).catch((caught: unknown) => caught);
}

describe("task result errors", () => {
	it("never reads the remote peer's failure text as a local gateway condition", async () => {
		// The peer's `failed` result reaches the gateway as a plain Error with its own text.
		for (const remoteText of ["AGX request outcome unknown", "AGX request storage failed"]) {
			expect(await recoveredFailure(new Error(remoteText))).toMatchObject({ status: 502, code: "task_failed" });
		}
		expect(await recoveredFailure(new AgxRequestUnknownError())).toMatchObject({ status: 409, code: "result_unknown" });
		expect(await recoveredFailure(new AgxPendingRequestStoreError())).toMatchObject({
			status: 500,
			code: "idempotency_store_failed",
		});
	});

	it("says nothing was sent when the first correlation write fails", async () => {
		const unsent = await taskFailure(new AgxPendingRequestStoreError({ mayHavePublished: false }));
		expect(unsent).toMatchObject({ status: 500, code: "idempotency_store_failed" });
		expect((unsent as { description?: string }).description).toMatch(/nothing was sent/i);
		const uncertain = await taskFailure(new AgxPendingRequestStoreError());
		expect((uncertain as { description?: string }).description).toMatch(/checked whether the remote agent executed/i);
	});
});

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { timeoutSignal } from "./runtime.js";

/** A real garbage collection, without starting Node with `--expose-gc`. */
function collectGarbage(): void {
	setFlagsFromString("--expose-gc");
	const gc = runInNewContext("gc") as () => void;
	gc();
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const wait = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("timeoutSignal", () => {
	it("still aborts at its deadline after a garbage collection", async () => {
		// The caller holds only the combined signal, as `fetch` does. On Node 20
		// the combined signal keeps its timeout source weakly, so a collection
		// could drop the timeout and the deadline never came.
		const signal = timeoutSignal(100, new AbortController().signal);
		let aborted = false;
		signal.addEventListener("abort", () => {
			aborted = true;
		});
		for (let i = 0; i < 5; i++) {
			collectGarbage();
			await tick();
		}
		await wait(400);
		expect(aborted).toBe(true);
		expect((signal.reason as Error).name).toBe("TimeoutError");
	});

	it("aborts with the caller's reason when the caller aborts first", () => {
		const caller = new AbortController();
		const signal = timeoutSignal(60_000, caller.signal);
		expect(signal.aborted).toBe(false);
		caller.abort(new Error("caller gave up"));
		expect(signal.aborted).toBe(true);
		expect((signal.reason as Error).message).toBe("caller gave up");
	});

	it("works with no caller signal", async () => {
		const signal = timeoutSignal(50);
		await wait(300);
		expect(signal.aborted).toBe(true);
		expect((signal.reason as Error).name).toBe("TimeoutError");
	});
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EXIT } from "../lib/errors.js";
import { setJsonMode } from "../lib/output.js";
import { loadState } from "../lib/state.js";
import { agx, capture, sandbox } from "../test/helpers.js";
import { waitCommand } from "./wait.js";

vi.mock("@nostr-agx/core", () => ({
	AgxClient: class {
		async start(): Promise<void> {}
		async pump(): Promise<{ cursor: number; dispatched: number; complete: boolean }> {
			return { cursor: 123, dispatched: 0, complete: false };
		}
		async stop(): Promise<void> {}
	},
}));

let box: ReturnType<typeof sandbox>;

beforeEach(async () => {
	box = sandbox();
	expect((await agx("identity", "new")).code).toBe(EXIT.ok);
	expect((await agx("config", "set", "relays", "ws://127.0.0.1:1")).code).toBe(EXIT.ok);
});

afterEach(() => {
	setJsonMode(false);
	process.exitCode = undefined;
	box.restore();
});

it("does not persist an incomplete pump's cursor", async () => {
	setJsonMode(true);
	await capture(() => waitCommand({ timeout: "1", summary: true, signal: new AbortController().signal }));
	expect(process.exitCode).toBe(EXIT.network);
	expect(loadState("default").cursor).toBe(0);
});

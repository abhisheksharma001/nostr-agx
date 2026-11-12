import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgxIncomingMessage } from "@nostr-agx/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EXIT } from "../lib/errors.js";
import { setJsonMode } from "../lib/output.js";
import { profileDir } from "../lib/paths.js";
import { MESSAGES_FILE } from "../lib/store/message-store.js";
import { agx, capture, jsonDocuments, sandbox } from "../test/helpers.js";
import { inboxCommand } from "./inbox.js";
import { waitCommand } from "./wait.js";

const control = vi.hoisted(() => ({
	mode: "deadline" as "deadline" | "stop",
	message: {
		from: "11".repeat(32),
		eventId: "22".repeat(32),
		createdAt: 1_800_000_000,
		text: "arrived at the boundary",
		contextId: "context-boundary",
		messageId: "message-boundary",
		autoDepth: null,
		subject: null,
		contentType: "text/plain",
	},
}));

vi.mock("@nostr-agx/core", () => ({
	AgxClient: class {
		private readonly onMessage: (msg: AgxIncomingMessage) => void;

		constructor(options: { onMessage: (msg: AgxIncomingMessage) => void }) {
			this.onMessage = options.onMessage;
		}

		async start(): Promise<void> {}

		async pump(): Promise<{ cursor: number; dispatched: number; complete: boolean }> {
			if (control.mode === "deadline") {
				this.onMessage(control.message);
				return new Promise(() => {});
			}
			return { cursor: 0, dispatched: 0, complete: true };
		}

		async stop(): Promise<void> {
			if (control.mode === "stop") {
				this.onMessage(control.message);
			}
		}
	},
}));

vi.mock("../lib/relay-probe.js", () => ({ probeRelay: async () => true }));

let box: ReturnType<typeof sandbox>;

beforeEach(async () => {
	box = sandbox();
	expect((await agx("identity", "new")).code).toBe(EXIT.ok);
	expect((await agx("config", "set", "relays", "ws://127.0.0.1:1")).code).toBe(EXIT.ok);
	expect((await agx("identity", "allow", control.message.from)).code).toBe(EXIT.ok);
	setJsonMode(true);
});

afterEach(() => {
	setJsonMode(false);
	process.exitCode = undefined;
	box.restore();
});

function storedTexts(): string[] {
	const path = join(profileDir("default"), MESSAGES_FILE);
	if (!existsSync(path)) {
		return [];
	}
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).text as string);
}

it("persists a batch dispatched before the wait deadline", async () => {
	control.mode = "deadline";
	const run = await capture(() => waitCommand({ timeout: "1", signal: new AbortController().signal }));
	const report = jsonDocuments(run.stdout).at(-1) as { messages: Array<{ text: string }>; timedOut: boolean };
	expect(report).toMatchObject({ timedOut: true });
	expect(report.messages.map((message) => message.text)).toEqual([control.message.text]);
	expect(storedTexts()).toEqual([control.message.text]);
});

it("persists messages dispatched while one-shot inbox stops", async () => {
	control.mode = "stop";
	const run = await capture(() => inboxCommand({ wait: "1" }));
	const report = jsonDocuments(run.stdout).at(-1) as { messages: Array<{ text: string }> };
	expect(report.messages.map((message) => message.text)).toEqual([control.message.text]);
	expect(storedTexts()).toEqual([control.message.text]);
});

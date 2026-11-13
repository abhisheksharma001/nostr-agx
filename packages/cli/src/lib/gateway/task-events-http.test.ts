import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./http";
import { TaskEventStreams } from "./task-events";
import { serveTaskEvents, TaskStreamSlots } from "./task-events-http";

const ID = "task_00000000-0000-0000-0000-000000000001";
const CREDENTIAL = "key-a";

const working = (seq: number) => ({ taskId: "remote", status: "working" as const, seq });

interface FakeResponse {
	res: ServerResponse;
	body: () => string;
	status: () => number | undefined;
	headers: Record<string, unknown>;
	ended: () => boolean;
	close: () => void;
}

function fakeResponse(): FakeResponse {
	const emitter = new EventEmitter();
	const chunks: string[] = [];
	const headers: Record<string, unknown> = {};
	let status: number | undefined;
	let ended = false;
	const res = Object.assign(emitter, {
		get writableEnded() {
			return ended;
		},
		setHeader(name: string, value: unknown) {
			headers[name.toLowerCase()] = value;
		},
		writeHead(code: number, extra?: Record<string, unknown>) {
			status = code;
			Object.assign(headers, extra ?? {});
			return res;
		},
		write(chunk: string) {
			chunks.push(chunk);
			return true;
		},
		end() {
			if (!ended) {
				ended = true;
				emitter.emit("close");
			}
		},
	}) as unknown as ServerResponse;
	return {
		res,
		body: () => chunks.join(""),
		status: () => status,
		headers,
		ended: () => ended,
		close: () => emitter.emit("close"),
	};
}

function request(lastEventId?: string): IncomingMessage {
	return {
		headers: lastEventId === undefined ? {} : { "last-event-id": lastEventId },
	} as unknown as IncomingMessage;
}

function setup(
	options: {
		view?: Record<string, unknown> | null;
		slots?: TaskStreamSlots;
		authorized?: () => boolean;
	} = {},
) {
	const streams = new TaskEventStreams();
	const stream = streams.ensure(ID);
	let view: Record<string, unknown> | null =
		options.view === undefined ? { id: ID, status: "running" } : options.view;
	const getView = vi.fn(() => view);
	const slots = options.slots ?? new TaskStreamSlots({ perCredential: 64, total: 256 });
	const open = (lastEventId?: string, credential = CREDENTIAL, response = fakeResponse()) => {
		serveTaskEvents(request(lastEventId), response.res, {
			id: ID,
			credential,
			getView,
			stillAuthorized: options.authorized ?? (() => true),
			streams,
			slots,
			heartbeatMs: 15_000,
			revalidateMs: 5_000,
		});
		return response;
	};
	const attempt = (credential = CREDENTIAL) => {
		const response = fakeResponse();
		try {
			open(undefined, credential, response);
			return { response, error: undefined };
		} catch (error) {
			return { response, error: error as ApiError };
		}
	};
	return {
		stream,
		streams,
		getView,
		slots,
		open,
		attempt,
		setView: (next: Record<string, unknown> | null) => {
			view = next;
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("serveTaskEvents", () => {
	it("writes working events as they arrive, without polling the store", () => {
		const { stream, getView, open, setView } = setup();
		const response = open();
		const lookups = getView.mock.calls.length;

		for (const seq of [1, 2, 3]) {
			stream.push(working(seq));
		}
		expect(response.body().match(/event: working/g)).toHaveLength(3);
		vi.advanceTimersByTime(1_000);
		expect(getView).toHaveBeenCalledTimes(lookups);

		setView({ id: ID, status: "completed", result: { ok: true } });
		stream.markTerminal();
		expect(response.body()).toContain("id: 4\nevent: completed");
		expect(response.ended()).toBe(true);
	});

	it("refuses past the per-credential and gateway-wide caps", () => {
		const slots = new TaskStreamSlots({ perCredential: 2, total: 3 });
		const { attempt } = setup({ slots });
		const first = attempt();
		const second = attempt();
		expect(first.response?.status()).toBe(200);
		expect(second.response?.status()).toBe(200);

		const third = attempt();
		expect(third.error).toBeInstanceOf(ApiError);
		expect(third.error).toMatchObject({ status: 429, code: "too_many_streams" });
		expect(third.response.headers["retry-after"]).toBe("5");
		expect(third.response.status()).toBeUndefined();
		expect(slots.open(CREDENTIAL)).toBe(2);

		expect(attempt("key-b").response?.status()).toBe(200);
		const fourth = attempt("key-c");
		expect(fourth.error).toMatchObject({ status: 503, code: "busy" });
		expect(slots.open()).toBe(3);

		first.response.close();
		expect(slots.open(CREDENTIAL)).toBe(1);
		expect(attempt().response?.status()).toBe(200);
	});

	it("takes no slot for a task it cannot find", () => {
		const slots = new TaskStreamSlots({ perCredential: 1, total: 1 });
		const { attempt } = setup({ slots, view: null });
		expect(attempt().error).toMatchObject({ status: 404 });
		expect(slots.open()).toBe(0);
	});

	it("answers 204 to a reconnect that already has the terminal event", () => {
		const slots = new TaskStreamSlots({ perCredential: 1, total: 1 });
		const { stream, open } = setup({ slots, view: { id: ID, status: "completed", result: { ok: true } } });
		stream.push(working(1));
		stream.push(working(2));
		stream.markTerminal();

		const done = open("3");
		expect(done.status()).toBe(204);
		expect(done.body()).toBe("");
		expect(done.ended()).toBe(true);
		expect(slots.open()).toBe(0);

		const behind = open("2");
		expect(behind.status()).toBe(200);
		expect(behind.body()).toContain("id: 3\nevent: completed");
		expect(behind.body()).not.toContain("event: working");
	});

	it("puts a lost stream's terminal event after the client's last ID", () => {
		// After a restart the buffer is empty, but the client has seen IDs up to 7.
		const { open } = setup({ view: { id: ID, status: "failed", error: { code: "task_failed" } } });
		const first = open("7");
		expect(first.status()).toBe(200);
		expect(first.body()).toContain("id: 8\nevent: failed");
		expect(open("8").status()).toBe(204);
	});

	it("treats a malformed Last-Event-ID as 0 and replays every buffered event", () => {
		for (const header of ["abc", "-1", "1.5", "99999999999999999999"]) {
			const { stream, open } = setup();
			stream.push(working(1));
			stream.push(working(2));
			const response = open(header);
			expect(response.body()).toContain("id: 1\nevent: working");
			expect(response.body()).toContain("id: 2\nevent: working");
			response.close();
		}
	});
});


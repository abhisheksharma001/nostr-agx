import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
	const open = (lastEventId?: string) => {
		const response = fakeResponse();
		serveTaskEvents(request(lastEventId), response.res, {
			id: ID,
			credential: CREDENTIAL,
			getView,
			stillAuthorized: options.authorized ?? (() => true),
			streams,
			slots,
			heartbeatMs: 15_000,
			revalidateMs: 5_000,
		});
		return response;
	};
	return {
		stream,
		streams,
		getView,
		slots,
		open,
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
});

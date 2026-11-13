import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./http.js";
import type { TaskOperationStore } from "./idempotency.js";
import type { TaskEventStreams } from "./task-events.js";

export function serveTaskEvents(
	req: IncomingMessage,
	res: ServerResponse,
	id: string,
	credential: string,
	taskOperations: TaskOperationStore,
	taskEvents: TaskEventStreams,
	heartbeatMs: number,
): void {
	const initial = taskOperations.get(credential, id);
	if (initial === null) {
		throw new ApiError(404, "not_found", "No background task with that ID for this credential");
	}
	const stream = taskEvents.ensure(id);
	const isTerminalView = (view: Record<string, unknown> | null) =>
		view?.status === "completed" || view?.status === "failed";
	const refreshTerminal = () => {
		if (isTerminalView(taskOperations.get(credential, id))) {
			stream.markTerminal();
		}
	};
	refreshTerminal();
	const parsedLastId = Number(req.headers["last-event-id"] ?? 0);
	let lastId = Number.isSafeInteger(parsedLastId) && parsedLastId > 0 ? parsedLastId : 0;
	let finished = false;
	let terminalTimer: ReturnType<typeof setInterval> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	const cleanup = () => {
		if (finished) {
			return;
		}
		finished = true;
		if (terminalTimer) {
			clearInterval(terminalTimer);
		}
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
		}
	};
	const finish = () => {
		cleanup();
		res.end();
	};
	const writeEvent = (eventId: number, event: string, data: Record<string, unknown>) => {
		res.write(`id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify({ taskId: id, ...data })}\n\n`);
		lastId = eventId;
	};
	const writeEvents = () => {
		for (const event of stream.after(lastId)) {
			writeEvent(event.id, event.event, event.data);
		}
		const terminalId = stream.getTerminalId();
		if (terminalId === undefined) {
			return;
		}
		// The store owns the outcome; the stream keeps only the terminal ID.
		const view = taskOperations.get(credential, id);
		if (isTerminalView(view)) {
			writeEvent(terminalId, view?.status as string, view as Record<string, unknown>);
		}
		finish();
	};

	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-store, no-transform",
		"connection": "keep-alive",
		"x-accel-buffering": "no",
		"x-content-type-options": "nosniff",
	});
	res.write("retry: 1000\n: connected\n\n");
	res.on("close", cleanup);
	terminalTimer = setInterval(() => {
		try {
			refreshTerminal();
			writeEvents();
		} catch {
			finish();
		}
	}, 250);
	heartbeatTimer = setInterval(() => {
		if (!res.writableEnded) {
			res.write(": heartbeat\n\n");
		}
	}, heartbeatMs);
	writeEvents();
}

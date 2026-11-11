import { describe, expect, it, vi } from "vitest";
import { AgxClient } from "./client";
import { randomId } from "./id";
import { encodeTaskEnvelope, parseTaskEnvelope } from "./task";
import type { AgxIncomingMessage, AgxTransport } from "./transport";
import { TASK_CONTENT_TYPE } from "./wire";

const ALICE = "alice";
const BOB = "bob";
const CAROL = "carol";

type PendingPhase = "publishing" | "waiting";
type PendingRecord = {
	key: string;
	taskId: string;
	peer: string;
	capability: string;
	deadlineAt: number | null;
	phase: PendingPhase;
};
type Recovered = { key: string; taskId: string; result: Promise<unknown> };
type RecoveringClient = AgxClient & {
	restorePendingRequests(): Promise<Recovered[]>;
	stop(opts?: { preservePending?: boolean }): Promise<void>;
};

class MemoryPendingStore {
	readonly records = new Map<string, PendingRecord>();
	readonly removed: string[] = [];
	failSavePhase?: PendingPhase;
	failRemove = false;

	list(): PendingRecord[] {
		return [...this.records.values()].map((record) => ({ ...record }));
	}

	save(record: PendingRecord): void {
		if (this.failSavePhase === record.phase) {
			throw new Error("disk full");
		}
		this.records.set(record.key, { ...record });
	}

	remove(key: string): void {
		if (this.failRemove) {
			throw new Error("read-only disk");
		}
		this.removed.push(key);
		this.records.delete(key);
	}
}

class MemoryTransport {
	private sequence = 0;
	readonly inbox = new Map<string, AgxIncomingMessage[]>();
	readonly sent: Array<{ from: string; to: string; text: string; contextId: string }> = [];

	constructor(private readonly identity: string) {}

	transport(): AgxTransport {
		return {
			whoami: () => this.identity,
			publishMessage: async (to, message) => {
				const contextId = message.contextId ?? randomId();
				this.sent.push({ from: this.identity, to, text: message.text, contextId });
				this.push(to, this.identity, message.text, contextId);
				return { ok: true, eventId: `sent-${this.sequence}`, contextId };
			},
			publishReceipt: async () => ({ ok: true }),
			poll: async () => ({
				messages: [...(this.inbox.get(this.identity) ?? [])],
				receipts: [],
				complete: true,
			}),
			resolvePeer: async () => ({ relays: [], card: null }),
		};
	}

	push(to: string, from: string, text: string, contextId: string): string {
		const eventId = `event-${++this.sequence}`;
		const messages = this.inbox.get(to) ?? [];
		messages.push({
			from,
			text,
			contextId,
			eventId,
			createdAt: this.sequence,
			messageId: eventId,
			subject: null,
			autoDepth: null,
			contentType: TASK_CONTENT_TYPE,
		});
		this.inbox.set(to, messages);
		return eventId;
	}

	result(to: string, from: string, taskId: string, contextId = taskId): string {
		return this.push(
			to,
			from,
			encodeTaskEnvelope({ t: "res", taskId, status: "completed", output: { ok: true } }),
			contextId,
		);
	}

	requests(to: string): string[] {
		return this.sent
			.filter((message) => message.to === to)
			.map((message) => parseTaskEnvelope(message.text))
			.filter((envelope) => envelope?.t === "req")
			.map((envelope) => envelope && envelope.t === "req" ? envelope.taskId : "");
	}
}

function durableClient(
	bus: MemoryTransport,
	store: MemoryPendingStore,
	extra: { maxRestoredRequests?: number; onMessage?: ReturnType<typeof vi.fn> } = {},
): RecoveringClient {
	return new AgxClient({
		transport: bus.transport(),
		pendingRequests: store,
		startCursor: 0,
		...extra,
	} as unknown as ConstructorParameters<typeof AgxClient>[0]) as RecoveringClient;
}

async function restore(client: RecoveringClient): Promise<Recovered[]> {
	return client.restorePendingRequests();
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition did not become true");
}

function seed(
	store: MemoryPendingStore,
	record: Partial<PendingRecord> & { key: string; taskId: string },
): PendingRecord {
	const full: PendingRecord = {
		peer: BOB,
		capability: "math.add",
		deadlineAt: Date.now() + 60_000,
		phase: "waiting",
		...record,
	};
	store.records.set(full.key, full);
	return full;
}

describe("durable pending-request recovery", () => {
	it("accepts the original peer's result after restart without publishing another task", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		const first = durableClient(bus, store);
		await restore(first);
		const original = first.request(BOB, "math.add", { a: 2, b: 3 }, { timeoutMs: 0 });
		original.catch(() => undefined);
		await waitFor(() => bus.requests(BOB).length === 1);
		const taskId = bus.requests(BOB)[0];
		await first.stop({ preservePending: true });
		await expect(original).rejects.toThrow("AGX client stopped");

		const second = durableClient(bus, store);
		const recovered = await restore(second);
		expect(recovered).toHaveLength(1);
		expect(recovered[0]).toMatchObject({ key: taskId, taskId });
		bus.result(ALICE, BOB, taskId);
		await second.pump();
		await expect(recovered[0].result).resolves.toEqual({ ok: true });
		expect(bus.requests(BOB)).toEqual([taskId]);
		await second.stop();
	});

	it("keeps wrong-peer and context-mismatch forgeries pending after restart", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1" });
		const client = durableClient(bus, store);
		const [recovered] = await restore(client);
		let settled = false;
		void recovered.result.finally(() => { settled = true; }).catch(() => undefined);

		bus.result(ALICE, CAROL, "task-1");
		await client.pump();
		expect(settled).toBe(false);
		expect(store.records.has("local-1")).toBe(true);
		bus.result(ALICE, BOB, "task-1", "another-context");
		await client.pump();
		expect(settled).toBe(false);
		expect(store.records.has("local-1")).toBe(true);

		bus.result(ALICE, BOB, "task-1");
		await client.pump();
		await expect(recovered.result).resolves.toEqual({ ok: true });
		await client.stop();
	});

	it("settles a duplicate result only once and removes correlation once", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1" });
		const onMessage = vi.fn();
		const client = durableClient(bus, store, { onMessage });
		const [recovered] = await restore(client);
		bus.result(ALICE, BOB, "task-1");
		await client.pump();
		await expect(recovered.result).resolves.toEqual({ ok: true });
		bus.result(ALICE, BOB, "task-1");
		await client.pump();
		expect(store.removed).toEqual(["local-1"]);
		expect(onMessage).toHaveBeenCalledTimes(1);
		await client.stop();
	});

	it("expires a restored request against its original deadline", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1", deadlineAt: Date.now() - 1 });
		const client = durableClient(bus, store);
		const [recovered] = await restore(client);
		await expect(recovered.result).rejects.toThrow(/timed out/);
		expect(store.records.has("local-1")).toBe(false);
		bus.result(ALICE, BOB, "task-1");
		await client.pump();
		await client.stop();
	});

	it("recovers a publishing record as unknown and never republishes it", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1", phase: "publishing" });
		const client = durableClient(bus, store);
		const [recovered] = await restore(client);
		await expect(recovered.result).rejects.toThrow(/unknown/i);
		expect(store.records.has("local-1")).toBe(false);
		expect(bus.requests(BOB)).toEqual([]);
		await client.stop();
	});

	it("does not publish when the initial durable write fails", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		store.failSavePhase = "publishing";
		const client = durableClient(bus, store);
		await restore(client);
		await expect(
			client.request(BOB, "math.add", {}, { timeoutMs: 0 }),
		).rejects.toThrow(/storage failed/i);
		expect(bus.requests(BOB)).toEqual([]);
		await client.stop();
	});

	it("reports an uncertain outcome and cancels when the waiting write fails after publish", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		store.failSavePhase = "waiting";
		const client = durableClient(bus, store);
		await restore(client);
		await expect(
			client.request(BOB, "math.add", {}, { timeoutMs: 0 }),
		).rejects.toThrow(/storage failed/i);
		expect(bus.requests(BOB)).toHaveLength(1);
		await waitFor(() => bus.sent.some((message) => parseTaskEnvelope(message.text)?.t === "cancel"));
		await client.stop();
	});

	it("holds dispatch and does not settle when final correlation removal fails", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1" });
		store.failRemove = true;
		const client = durableClient(bus, store);
		const [recovered] = await restore(client);
		let settled = false;
		void recovered.result.finally(() => { settled = true; }).catch(() => undefined);
		bus.result(ALICE, BOB, "task-1");
		const failedPump = await client.pump();
		expect(failedPump.complete).toBe(false);
		expect(settled).toBe(false);
		expect(store.records.has("local-1")).toBe(true);

		store.failRemove = false;
		await client.pump();
		await expect(recovered.result).resolves.toEqual({ ok: true });
		await client.stop();
	});

	it("preserves waiting records only for an explicit restart stop", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		const first = durableClient(bus, store);
		await restore(first);
		const pending = first.request(BOB, "math.add", {}, { timeoutMs: 0 });
		pending.catch(() => undefined);
		await waitFor(() => bus.requests(BOB).length === 1);
		const taskId = bus.requests(BOB)[0];
		await first.stop({ preservePending: true });
		expect(store.records.has(taskId)).toBe(true);
		expect(bus.sent.filter((message) => parseTaskEnvelope(message.text)?.t === "cancel")).toHaveLength(0);

		const second = durableClient(bus, store);
		const [recovered] = await restore(second);
		recovered.result.catch(() => undefined);
		await second.stop();
		expect(store.records.has(taskId)).toBe(false);
		await waitFor(() => bus.sent.some((message) => parseTaskEnvelope(message.text)?.t === "cancel"));
	});

	it("requires restoration before polling or starting live delivery", async () => {
		const bus = new MemoryTransport(ALICE);
		const store = new MemoryPendingStore();
		seed(store, { key: "local-1", taskId: "task-1" });
		const client = durableClient(bus, store);
		await expect(client.pump()).rejects.toThrow(/restore/i);
		await expect(client.start({ pollIntervalMs: 0, advertise: false })).rejects.toThrow(/restore/i);
		await restore(client);
		await client.pump();
		await client.stop();
	});

	it("bounds restored records and rejects malformed records before receiving", async () => {
		const bus = new MemoryTransport(ALICE);
		const crowded = new MemoryPendingStore();
		seed(crowded, { key: "local-1", taskId: "task-1" });
		seed(crowded, { key: "local-2", taskId: "task-2" });
		const limited = durableClient(bus, crowded, { maxRestoredRequests: 1 });
		await expect(restore(limited)).rejects.toThrow(/too many|limit/i);

		const malformed = new MemoryPendingStore();
		seed(malformed, { key: "local-1", taskId: "task-1", peer: "" });
		const client = durableClient(bus, malformed);
		await expect(restore(client)).rejects.toThrow(/invalid|record/i);
	});
});

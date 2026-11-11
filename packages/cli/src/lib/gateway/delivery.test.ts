import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeForTests } from "../runtime.js";
import { DeliveryQueue, deliver, MAX_ANSWER_BYTES, signDelivery } from "./delivery.js";
import type { Subscription } from "./subscriptions.js";

const subscription: Subscription = {
	id: "sub_1",
	secret: "s3cret",
	createdAt: 0,
	label: null,
	url: "http://127.0.0.1:1/hook",
	events: ["message"],
	capabilities: [],
	acceptAll: true,
	allowedPeers: [],
	includeUnlisted: false,
	maxTaskAgeSec: 600,
	resultTimeoutSec: 5,
	advertise: false,
};

const servers: Server[] = [];
let restore: (() => void) | undefined;
afterEach(() => {
	restore?.();
	restore = undefined;
	stopServers();
});

interface Received {
	headers: IncomingMessage["headers"];
	body: string;
}

/** A webhook on loopback: `handle` answers each request it receives. */
async function webhook(handle: (req: IncomingMessage, res: ServerResponse, n: number) => void) {
	const received: Received[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
			handle(req, res, received.length);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, received };
}

/** Stop every webhook: what is waiting on one fails at once. */
function stopServers() {
	for (const server of servers.splice(0)) {
		server.close();
		server.closeAllConnections();
	}
}

/** A loopback port nothing listens on. */
async function closedPort(): Promise<string> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return `http://127.0.0.1:${port}/hook`;
}

function answer(res: ServerResponse, status: number, body: unknown = {}) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

/** Retries wait no real time. */
function instantRetries() {
	restore = setRuntimeForTests({ sleep: async () => undefined });
}

describe("signDelivery", () => {
	it("is an HMAC-SHA256 of the timestamp and the exact body", () => {
		const body = '{"event":"message"}';
		const expected = createHmac("sha256", "s3cret").update(`1700000000.${body}`).digest("hex");
		expect(signDelivery("s3cret", 1700000000, body)).toBe(`v1=${expected}`);
	});
});

describe("deliver", () => {
	it("signs what it sends, and parses the answer", async () => {
		const hook = await webhook((_req, res) => answer(res, 200, { ok: 1 }));
		const outcome = await deliver({ ...subscription, url: hook.url }, { event: "message", text: "hi" }, "evt1", 1000);
		expect(outcome).toEqual({ kind: "response", status: 200, body: { ok: 1 } });
		const [{ headers, body }] = hook.received;
		expect(headers["x-agx-signature"]).toBe(signDelivery("s3cret", Number(headers["x-agx-timestamp"]), body));
		expect(headers["x-agx-delivery"]).toBe("evt1");
		expect(headers["x-agx-subscription"]).toBe("sub_1");
		expect(JSON.parse(body)).toEqual({ event: "message", text: "hi" });
	});

	it("does not follow a redirect: the signed event goes only where the subscription says", async () => {
		const elsewhere = await webhook((_req, res) => answer(res, 200));
		const hook = await webhook((_req, res) => {
			res.writeHead(307, { location: elsewhere.url });
			res.end();
		});
		const outcome = await deliver({ ...subscription, url: hook.url }, { event: "task" }, "e", 1000);
		expect(outcome).toMatchObject({ kind: "response", status: 307 });
		expect(elsewhere.received).toHaveLength(0);
	});

	it("tells a webhook nobody could connect to from a connection that broke off", async () => {
		await expect(deliver({ ...subscription, url: await closedPort() }, { event: "task" }, "e", 1000)).resolves.toMatchObject({
			kind: "unreachable",
			sent: false,
		});
		const hook = await webhook((req) => req.socket.destroy());
		await expect(deliver({ ...subscription, url: hook.url }, { event: "task" }, "e", 1000)).resolves.toMatchObject({
			kind: "unreachable",
			sent: true,
		});
	});

	it("counts an answer that stalls after its headers as a timeout", async () => {
		const hook = await webhook((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.write("{");
		});
		await expect(deliver({ ...subscription, url: hook.url }, { event: "task" }, "e", 300)).resolves.toEqual({ kind: "timeout" });
	});

	it("stops reading an answer larger than it could ever send on", async () => {
		const hook = await webhook((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(`"${"x".repeat(MAX_ANSWER_BYTES + 10)}"`);
		});
		await expect(deliver({ ...subscription, url: hook.url }, { event: "task" }, "e", 5000)).resolves.toEqual({ kind: "oversized" });
	});
});

describe("DeliveryQueue", () => {
	it("retries a webhook that could not be reached, or whose proxy was, then succeeds", async () => {
		instantRetries();
		const hook = await webhook((_req, res, n) => answer(res, n < 3 ? 503 : 200));
		const failures: string[] = [];
		const queue = new DeliveryQueue({ retryDelaysMs: [1, 1], onFailure: (_s, id) => failures.push(id) });
		queue.enqueue({ ...subscription, url: hook.url }, { event: "message" }, "e1");
		await queue.idle();
		expect(hook.received).toHaveLength(3);
		expect(failures).toEqual([]);
	});

	it("waits out a retry without holding up deliveries to other webhooks", async () => {
		let releaseRetry: () => void = () => undefined;
		restore = setRuntimeForTests({
			sleep: () =>
				new Promise<void>((resolve) => {
					releaseRetry = resolve;
				}),
		});
		const up = await webhook((_req, res) => answer(res, 200));
		const queue = new DeliveryQueue({ concurrency: 1, retryDelaysMs: [60_000] });
		queue.enqueue({ ...subscription, id: "down", url: await closedPort() }, { event: "message" }, "e1");
		queue.enqueue({ ...subscription, id: "up", url: up.url }, { event: "message" }, "e2");
		for (let i = 0; i < 100 && up.received.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 10));
		}
		// The healthy webhook got its delivery while the other waits to retry.
		expect(up.received).toHaveLength(1);
		releaseRetry();
		await queue.idle();
	});

	it("gives each webhook its own slots, so a stalled one does not hold up the rest", async () => {
		const stalled = await webhook(() => undefined);
		const healthy = await webhook((_req, res) => answer(res, 200));
		const queue = new DeliveryQueue({ concurrency: 4, perSubscription: 2, retryDelaysMs: [], timeoutMs: 2000 });
		for (let i = 0; i < 5; i++) {
			queue.enqueue({ ...subscription, id: "stalled", url: stalled.url }, { event: "message" }, `s${i}`);
		}
		queue.enqueue({ ...subscription, id: "healthy", url: healthy.url }, { event: "message" }, "h1");
		for (let i = 0; i < 100 && healthy.received.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(healthy.received).toHaveLength(1);
		// The healthy webhook can answer before the stalled one has received its
		// second delivery, and its delivery only counts as done once the answer is
		// read. Wait for both before counting.
		for (let i = 0; i < 100 && (stalled.received.length < 2 || queue.pending() !== 5); i++) {
			await new Promise((r) => setTimeout(r, 10));
		}
		// Two of the stalled webhook's deliveries are in flight, not four.
		expect(stalled.received).toHaveLength(2);
		expect(queue.pending()).toBe(5);
		stopServers();
		await queue.idle();
	});

	it("drops a webhook's own oldest delivery when too many wait for it", async () => {
		const stalled = await webhook(() => undefined);
		const failures: string[] = [];
		const queue = new DeliveryQueue({
			concurrency: 1,
			perSubscription: 1,
			maxQueuedPerSubscription: 2,
			retryDelaysMs: [],
			timeoutMs: 2000,
			onFailure: (_s, id, detail) => failures.push(`${id}: ${detail}`),
		});
		for (let i = 0; i < 4; i++) {
			queue.enqueue({ ...subscription, id: "stalled", url: stalled.url }, { event: "message" }, `e${i}`);
		}
		// e0 is in flight; e1..e3 wait, two at most: e1 goes.
		expect(failures).toEqual(["e1: dropped: too many deliveries waiting"]);
		stopServers();
		await queue.idle();
	});

	it("does not retry the webhook's own error, since the workflow may have run", async () => {
		instantRetries();
		const hook = await webhook((_req, res) => answer(res, 500));
		const failures: string[] = [];
		const queue = new DeliveryQueue({ retryDelaysMs: [1, 1], onFailure: (_s, id, detail) => failures.push(`${id}: ${detail}`) });
		queue.enqueue({ ...subscription, url: hook.url }, { event: "message" }, "e2");
		await queue.idle();
		expect(hook.received).toHaveLength(1);
		expect(failures).toEqual(["e2: HTTP 500"]);
	});
});

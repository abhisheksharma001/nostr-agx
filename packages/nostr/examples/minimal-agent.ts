/**
 * Minimal AGX agent — the whole integration for a runtime like Paperclip/Buzz.
 * A responder advertises + handles a capability; an initiator requests it. The
 * library owns identity, encryption, relays, correlation, receipts, and the task
 * lifecycle — the runtime only writes the handler.
 *
 *   pnpm build                                      # at the repository root
 *   cd packages/nostr && pnpm dlx tsx examples/minimal-agent.ts
 *
 * (Point RELAY at any Nostr relay; a local one works: `ws://127.0.0.1:7447`.)
 */
import { AgxClient } from "@nostr-agx/core";
import WebSocket from "ws";
import { generateKeypair, localSigner, NostrTransport } from "../src/index";

const RELAY = process.env.AGX_RELAY ?? "ws://127.0.0.1:7447";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	// --- Responder: a runtime that reviews invoices ------------------------
	const responderKey = generateKeypair();
	// The initiator's pubkey — in a real agent this is your trust list / allowlist,
	// not a single hard-coded key.
	const initiatorKey = generateKeypair();
	const responder = new AgxClient({
		transport: await NostrTransport.create({
			signer: localSigner(responderKey.secretKey),
			relays: [RELAY],
			ws: WebSocket,
		}),
		identity: { org: "Acme Finance" },
		// Gate who may invoke your capabilities. Authorization is DEFAULT-DENY: with
		// no `authorize` hook, every task request is dropped (a registered handler is
		// reachable by any pubkey on the internet, so opening it must be deliberate).
		// Return true to let a request run. (Pass `authorize: "accept-all"` only if
		// open access is truly intended.)
		authorize: ({ from }) => from === initiatorKey.publicKey,
	});

	// The whole integration surface: register a capability handler and return a
	// result. Dispatch → task lifecycle → result → receipt → correlation are the
	// library's job.
	responder.handle<{ amount: number; vendor: string }, { approved: boolean }>(
		"invoice.review",
		async (task) => {
			// `task.payload` is whatever the initiator sent; do the real work here
			// (call your agent runtime, an LLM, a rules engine, …).
			return { approved: task.payload.amount < 10_000 };
		},
	);

	// --- Initiator: asks a peer to review an invoice -----------------------
	const initiator = new AgxClient({
		transport: await NostrTransport.create({
			signer: localSigner(initiatorKey.secretKey),
			relays: [RELAY],
			ws: WebSocket,
		}),
	});

	try {
		// Poll-only request: neither client is started; the host controls dispatch
		// by calling pump() itself.
		let pollOnlySettled = false;
		const pollOnlyResult = initiator
			.request<{ approved: boolean }>(
				responder.whoami(),
				"invoice.review",
				{ amount: 4200, vendor: "Globex" },
			)
			.finally(() => {
				pollOnlySettled = true;
			});
		while (!pollOnlySettled) {
			await responder.pump();
			await initiator.pump();
			if (!pollOnlySettled) {
				await sleep(100);
			}
		}
		console.info("poll-only invoice.review →", await pollOnlyResult);

		// Managed lifecycle: start() enables live delivery and scheduled polling;
		// streamRequest() exposes progress events and the final result promise.
		await Promise.all([
			responder.start({ pollIntervalMs: 100 }),
			initiator.start({ pollIntervalMs: 100 }),
		]);

		const stream = await initiator.streamRequest<{ approved: boolean }>(
			responder.whoami(),
			"invoice.review",
			{ amount: 4200, vendor: "Globex" },
		);

		stream.on("error", (err) => {
			console.error("invoice.review error →", err);
		});
		stream.on("statusUpdate", (status) => {
			console.log("invoice.review status →", status);
		});
		stream.on("completed", (output) => {
			console.log("streamed invoice.review →", output);
		});
		console.info("streamed result →", await stream.result);
	} finally {
		await Promise.all([initiator.stop(), responder.stop()]);
	}
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error(err);
		process.exit(1);
	},
);

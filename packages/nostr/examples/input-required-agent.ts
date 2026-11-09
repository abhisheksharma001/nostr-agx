/**
 * Human-in-the-loop AGX task: the responder suspends its handler until the
 * initiator supplies the requested input.
 *
 *   pnpm build                                      # at the repository root
 *   cd packages/nostr && pnpm dlx tsx examples/input-required-agent.ts
 *
 * (Point AGX_RELAY at any Nostr relay; a local one works: `ws://127.0.0.1:7447`.)
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AgxClient } from "@nostr-agx/core";
import WebSocket from "ws";
import { generateKeypair, localSigner, NostrTransport } from "../src/index";

const RELAY = process.env.AGX_RELAY ?? "ws://127.0.0.1:7447";

async function main() {
	const responderKey = generateKeypair();
	const initiatorKey = generateKeypair();
	const responder = new AgxClient({
		transport: await NostrTransport.create({
			signer: localSigner(responderKey.secretKey),
			relays: [RELAY],
			ws: WebSocket,
		}),
		identity: { org: "Acme Finance" },
		authorize: ({ from }) => from === initiatorKey.publicKey,
	});

	responder.handle<
		{ amount: number; vendor: string },
		{ approved: boolean }
	>("invoice.review", async (task, ctx) => {
		const approved = await ctx.requestInput({
			id: "invoice-approval",
			prompt: `Approve ${task.payload.vendor}'s invoice for $${task.payload.amount}?`,
			inputSchema: { type: "boolean" },
			timeoutMs: 120_000,
		});
		return { approved: approved === true };
	});

	const initiator = new AgxClient({
		transport: await NostrTransport.create({
			signer: localSigner(initiatorKey.secretKey),
			relays: [RELAY],
			ws: WebSocket,
		}),
	});
	const prompt = createInterface({ input: stdin, output: stdout });

	try {
		await Promise.all([
			responder.start({ pollIntervalMs: 100 }),
			initiator.start({ pollIntervalMs: 100 }),
		]);

		const stream = await initiator.streamRequest<{ approved: boolean }>(
			responder.whoami(),
			"invoice.review",
			{ amount: 4200, vendor: "Globex" },
			{ timeoutMs: 120_000 },
		);
		let resolveInput!: () => void;
		let rejectInput!: (error: Error) => void;
		const inputProvided = new Promise<void>((resolve, reject) => {
			resolveInput = resolve;
			rejectInput = reject;
		});

		stream.on("statusUpdate", (status) => {
			console.info("invoice.review status →", status);
		});
		stream.on("error", (error) => {
			console.error("invoice.review error →", error);
		});
		stream.on("inputRequired", (update) => {
			void (async () => {
				const answer = await prompt.question(
					`${update.requirement.prompt} [y/N] `,
				);
				await stream.provideInput(
					update.inputRequestId,
					/^y(es)?$/i.test(answer.trim()),
				);
				resolveInput();
			})().catch((error: unknown) => {
				rejectInput(
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		});

		const [result] = await Promise.all([stream.result, inputProvided]);
		console.info("invoice.review result →", result);
	} finally {
		prompt.close();
		await Promise.all([initiator.stop(), responder.stop()]);
	}
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});

/**
 * Multi-turn human-in-the-loop AGX task: the responder suspends its handler
 * after each question until the initiator supplies the next answer.
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
		{ purpose: string; costCenter: string; approved: boolean }
	>("invoice.review", async (task, ctx) => {
		const purpose = await ctx.requestInput({
			id: "invoice-purpose",
			prompt: `What was ${task.payload.vendor}'s $${task.payload.amount} invoice for?`,
			inputSchema: { type: "string" },
			timeoutMs: 120_000,
		});
		const costCenter = await ctx.requestInput({
			id: "invoice-cost-center",
			prompt: `Which cost center should be charged for "${String(purpose)}"?`,
			inputSchema: { type: "string" },
			timeoutMs: 120_000,
		});
		const approved = await ctx.requestInput({
			id: "invoice-approval",
			prompt: `Approve the $${task.payload.amount} ${task.payload.vendor} invoice for "${String(purpose)}" under ${String(costCenter)}?`,
			inputSchema: { type: "boolean" },
			timeoutMs: 120_000,
		});
		return {
			purpose: String(purpose),
			costCenter: String(costCenter),
			approved: approved === true,
		};
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

		const stream = await initiator.streamRequest<{
			purpose: string;
			costCenter: string;
			approved: boolean;
		}>(
			responder.whoami(),
			"invoice.review",
			{ amount: 4200, vendor: "Globex" },
			{ timeoutMs: 120_000 },
		);
		let rejectConversation!: (error: Error) => void;
		const conversationError = new Promise<never>((_resolve, reject) => {
			rejectConversation = reject;
		});

		stream.on("statusUpdate", (status) => {
			console.info("invoice.review status →", status);
		});
		stream.on("error", (error) => {
			console.error("invoice.review error →", error);
		});
		stream.on("inputRequired", (update) => {
			void (async () => {
				const inputSchema = update.requirement.inputSchema;
				const isBooleanInput =
					inputSchema !== null &&
					typeof inputSchema === "object" &&
					"type" in inputSchema &&
					inputSchema.type === "boolean";
				console.info("responder asks →", update.requirement.prompt);
				const answerText = await prompt.question(
					isBooleanInput ? "[y/N] " : "> ",
				);
				const answer = isBooleanInput
					? /^y(es)?$/i.test(answerText.trim())
					: answerText.trim();
				console.info(
					"initiator answers →",
					typeof answer === "boolean" ? (answer ? "yes" : "no") : answer,
				);
				await stream.provideInput(
					update.inputRequestId,
					answer,
				);
			})().catch((error: unknown) => {
				rejectConversation(
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		});

		const result = await Promise.race([stream.result, conversationError]);
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

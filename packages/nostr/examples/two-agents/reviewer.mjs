/**
 * Agent 1 of 2 — the reviewer (responder). A long-running AGX agent with a
 * persistent identity, default-deny authorization, an advertised Agent Card,
 * and a LOCAL LLM behind its capability handler.
 *
 *   node examples/two-agents/reviewer.mjs       # from packages/nostr, after pnpm build
 *
 * The handler is the agent loop, and the model is in it: after asking the
 * requester for the invoice's purpose (the input-required workflow — the
 * handler SUSPENDS there and resumes on the peer's answer), the model reviews
 * the transcript against policy and returns APPROVE, REJECT, or ASK — an ASK
 * sends another input-required round, so how many questions this agent asks
 * is the model's decision, not a script's. On APPROVE it asks the requester
 * for a final yes/no confirmation before completing the task.
 *
 * The LLM server is configured by llm.mjs (AGX_LLM_BASE_URL, AGX_LLM_MODEL).
 * With no server reachable, no model installed on it, or a model call failing
 * mid-task, this agent says so and falls back to a fixed canned policy — every
 * decision it makes is labelled with who made it (`decidedBy` in the task
 * result: `llm:<model>` or `canned-fallback`), so a model-made decision is
 * never confused with a stub's.
 *
 * Needs the local relay running (`node packages/cli/dist/agx.js relay` at the
 * repository root) and the identities provisioned
 * (`node examples/two-agents/provision.mjs`). Leave it running; run
 * requester.mjs in a third terminal to watch the exchange from the other side.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgxClient } from "@nostr-agx/core";
import { hexToBytes, localSigner, NostrTransport } from "@nostr-agx/nostr";
import WebSocket from "ws";
import { chat, resolveLlmSetup } from "./llm.mjs";

const RELAY = process.env.AGX_RELAY ?? "ws://127.0.0.1:7447";
/** Bound on model-driven ASK rounds, so a confused model cannot loop the
 * requester forever. The intake question and the final confirmation are
 * outside this bound. */
const MAX_ASK_ROUNDS = 2;
/** Per input requirement. Generous because the requester may itself be
 * waiting on a local model. */
const INPUT_TIMEOUT_MS = 120_000;

function loadAgent(name) {
	const file = fileURLToPath(
		new URL(`./.two-agents/${name}.json`, import.meta.url),
	);
	return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * One reviewer process per identity, like `agx serve`'s profile lock: two
 * processes sharing one keypair would both poll the relay, both dispatch
 * every task, and both answer — the requester would see doubled questions.
 * A lock left by a dead process is stale and gets taken over.
 */
function acquireIdentityLock(name) {
	const lockFile = fileURLToPath(
		new URL(`./.two-agents/${name}.lock`, import.meta.url),
	);
	const pidAlive = (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return error?.code === "EPERM";
		}
	};
	if (existsSync(lockFile)) {
		const pid = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10);
		if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
			console.error(
				`another ${name} agent (pid ${pid}) is already running on this identity — stop it first.`,
			);
			process.exit(1);
		}
		rmSync(lockFile, { force: true });
	}
	writeFileSync(lockFile, `${process.pid}\n`, { mode: 0o600 });
	const release = () => rmSync(lockFile, { force: true });
	process.on("exit", release);
	// SIGTERM (pkill, kill) terminates without firing "exit" — handle it so
	// the lock file does not outlive the process. Ctrl-C runs the main
	// SIGINT handler below, which exits cleanly.
	process.on("SIGTERM", () => {
		release();
		process.exit(143);
	});
}

const clock = () => new Date().toISOString().slice(11, 23);
const short = (pubkey) => `${pubkey.slice(0, 10)}…${pubkey.slice(-6)}`;
const log = (line) => console.log(`${clock()}  reviewer    ${line}`);

const me = loadAgent("reviewer");
// The one key this agent trusts: its allowlist. Authorization is DEFAULT-DENY.
const peer = loadAgent("requester");
// Take the identity lock before anything else: a second reviewer on this
// keypair would double-answer every task.
acquireIdentityLock("reviewer");

const transport = await NostrTransport.create({
	signer: localSigner(hexToBytes(me.secretHex)),
	relays: [RELAY],
	ws: WebSocket,
});

const client = new AgxClient({
	transport,
	identity: { org: "Acme Finance — invoice desk (demo)" },
	// A registered handler is executable by ANY pubkey that can reach this
	// agent, so every request is dropped unless this hook allows it.
	authorize: ({ from, capability }) => {
		const allowed = from === peer.publicKey;
		log(
			`${allowed ? "ALLOW" : "DENY "} task ${capability} from ${short(from)}`,
		);
		return allowed;
	},
	onMessage: (msg) =>
		log(`plain message from ${short(msg.from)} — not a task, ignored`),
	// Ignore events from before this start: a restarted reviewer must not
	// replay an old request whose requester is long gone.
	startCursor: Math.floor(Date.now() / 1000) - 60,
});

// Startup model check: a reachable server is not enough — the model must be
// installed, or every completion would 404 (Ollama: "model not found").
const llm = await resolveLlmSetup(log);
// Set when a model call fails mid-task: the run degrades to the canned policy
// instead of dying, and every result says so.
let llmDegraded = false;

/**
 * The model's judgment step. Given the invoice and the Q&A transcript so far,
 * return { verdict: "approve" | "reject" | "ask", rationale, question? }.
 *
 * The prompt uses a short first-line protocol (APPROVE/REJECT/ASK: …) rather
 * than JSON: small local models keep to it far more reliably.
 */
async function judge(payload, transcript) {
	const canned = (rationale) => ({
		verdict: Number(payload.amount) <= 5_000 ? "approve" : "reject",
		rationale: `${rationale} (canned policy)`,
		question: null,
	});
	if (!llm.ready) {
		return canned(
			Number(payload.amount) <= 5_000
				? "amount is inside the $5,000 auto-approve band"
				: "amount exceeds the $5,000 approval band",
		);
	}
	const system = [
		"You are the invoice reviewer for Acme Finance.",
		"Policy: approve only business purposes, with amount at most $5,000, that are consistent with the requester's answers.",
		"Reply with EXACTLY one first line, nothing before it:",
		"APPROVE — one short reason",
		"REJECT — one short reason",
		"ASK — the follow-up question to send the requester",
	].join("\n");
	const user = [
		`Invoice: $${payload.amount} from ${payload.vendor}.`,
		"Transcript so far:",
		...transcript.map(
			({ q, a }) => `  reviewer asked: ${q}\n  requester answered: ${a}`,
		),
		"Decide now.",
	].join("\n");
	let raw;
	try {
		raw = await chat(
			[
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			{ model: llm.model },
		);
	} catch (error) {
		llmDegraded = true;
		log(
			`model call failed → ${error?.message ?? String(error)} — this decision falls back to the canned policy`,
		);
		return canned(
			Number(payload.amount) <= 5_000
				? "amount is inside the $5,000 auto-approve band"
				: "amount exceeds the $5,000 approval band",
		);
	}
	log(`model says → ${raw.split("\n")[0].slice(0, 120)}`);
	const first = raw.split("\n")[0].trim();
	const match = /^(APPROVE|REJECT|ASK)\b\s*[—:-]?\s*(.*)$/i.exec(first);
	if (!match) {
		// Unparseable model output degrades to asking, never to guessing.
		return {
			verdict: "ask",
			rationale: "model output was unparseable",
			question:
				"Could you restate what this invoice covers, in one sentence?",
		};
	}
	const verdict = match[1].toLowerCase();
	const rest = match[2].trim();
	if (verdict === "ask" && !rest) {
		return {
			verdict: "ask",
			rationale: "model asked without a question",
			question: "Could you restate what this invoice covers, in one sentence?",
		};
	}
	return {
		verdict,
		rationale: rest || "(model gave no reason)",
		question: verdict === "ask" ? rest : null,
	};
}

client.handle("invoice.review", async (task, ctx) => {
	log(`TASK invoice.review  payload ${JSON.stringify(task.payload)}`);

	// Intake: the input-required workflow. The handler suspends here — the
	// question travels to the requester as an encrypted Nostr event, the task
	// slot is released, and this handler resumes on the peer's continuation.
	const purpose = await ctx.requestInput({
		id: "invoice-purpose",
		prompt: `What was ${task.payload.vendor}'s $${task.payload.amount} invoice for?`,
		inputSchema: { type: "string" },
		timeoutMs: INPUT_TIMEOUT_MS,
	});
	log(`requester answered → purpose "${String(purpose)}"`);

	// The agent loop: the model decides whether it has enough to rule, or
	// asks another question — each ASK is another input-required round.
	const transcript = [
		{
			q: `What was the ${task.payload.vendor} invoice for?`,
			a: String(purpose),
		},
	];
	let decision = await judge(task.payload, transcript);
	for (let round = 0; decision.verdict === "ask"; round += 1) {
		if (round >= MAX_ASK_ROUNDS) {
			decision = {
				verdict: "reject",
				rationale: `still unclear after ${MAX_ASK_ROUNDS} follow-up questions: ${decision.rationale}`,
				question: null,
			};
			log(`ask ceiling (${MAX_ASK_ROUNDS}) reached → rejecting`);
			break;
		}
		log(`model wants more input → asking: "${decision.question}"`);
		const answer = await ctx.requestInput({
			id: `invoice-followup-${round + 1}`,
			prompt: decision.question,
			inputSchema: { type: "string" },
			timeoutMs: INPUT_TIMEOUT_MS,
		});
		log(`requester answered → "${String(answer)}"`);
		transcript.push({ q: decision.question, a: String(answer) });
		decision = await judge(task.payload, transcript);
	}

	// Final confirmation: the requester gets the last word on its own money —
	// a boolean input-required round, answered by the requester's own model.
	let approved = decision.verdict === "approve";
	if (approved) {
		const confirm = await ctx.requestInput({
			id: "invoice-confirmation",
			prompt: `I'm ready to approve the $${task.payload.amount} ${task.payload.vendor} invoice for "${String(purpose)}" — confirm?`,
			inputSchema: { type: "boolean" },
			timeoutMs: INPUT_TIMEOUT_MS,
		});
		approved = confirm === true;
		log(`requester confirmed → ${approved ? "yes" : "no"}`);
	}

	return {
		approved,
		purpose: String(purpose),
		vendor: task.payload.vendor,
		amount: task.payload.amount,
		rationale: decision.rationale,
		questions: transcript.length,
		decidedBy:
			llm.ready && !llmDegraded
				? `llm:${llm.model}`
				: llm.ready
					? "canned-fallback (an llm call failed — see the reviewer log)"
					: "canned-fallback",
		reviewedBy: me.publicKey,
		reviewedAt: new Date().toISOString(),
	};
});

await client.start({ pollIntervalMs: 200, advertise: true });
log(
	`up on ${RELAY} — card advertised, allowlist: requester ${short(peer.publicKey)}`,
);
log("waiting for tasks — Ctrl-C to stop");

process.on("SIGINT", () => {
	void (async () => {
		log("stopping…");
		await client.stop().catch(() => undefined);
		process.exit(0);
	})();
});

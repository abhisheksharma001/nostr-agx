/**
 * Create the two demo agents' persistent identities — one file per agent,
 * kept on disk so re-runs reuse the same keys. This is the same idea as
 * `agx identity new --profile <name>`, scoped to this example: an agent's
 * identity should survive its process.
 *
 *   node examples/two-agents/provision.mjs      # from packages/nostr
 *
 * Identities land in `.two-agents/` next to this file (git-ignored, 0600).
 * Delete that folder to start over with fresh keys. Each agent later reads
 * only its own secret plus the peer's PUBLIC key from the peer's file —
 * the demo stand-in for an operator configuring each agent's allowlist
 * out-of-band (`agx identity allow <peer npub>`).
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { bytesToHex, generateKeypair } from "@nostr-agx/nostr";

const dir = fileURLToPath(new URL("./.two-agents", import.meta.url));
mkdirSync(dir, { recursive: true });
chmodSync(dir, 0o700);

for (const name of ["reviewer", "requester"]) {
	const file = `${dir}/${name}.json`;
	if (existsSync(file)) {
		const existing = JSON.parse(readFileSync(file, "utf8"));
		console.log(
			`${name}: exists — pubkey ${existing.publicKey.slice(0, 16)}… (delete ${dir} to reset)`,
		);
		continue;
	}
	const keypair = generateKeypair();
	const record = {
		name,
		role:
			name === "reviewer"
				? "invoice reviewer (responder agent)"
				: "invoice requester (initiator agent)",
		publicKey: keypair.publicKey,
		// The secret never leaves this machine; both agents here are ours.
		secretHex: bytesToHex(keypair.secretKey),
	};
	writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
	console.log(`${name}: created — pubkey ${keypair.publicKey.slice(0, 16)}…`);
}

console.log(`identities in ${dir}`);

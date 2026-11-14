import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentity } from "../lib/identity.js";

// Drives the BUILT CLI (`pnpm build` first, then `pnpm test:e2e:config`): the
// lost update this guards against is two real processes writing config.json.

const AGX = fileURLToPath(new URL("../../dist/agx.js", import.meta.url));

interface Run {
	code: number | null;
	stdout: string;
}

let home: string;

function agx(...args: string[]): Promise<Run> {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("AGX_")) {
			delete env[key];
		}
	}
	env.AGX_HOME = home;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [AGX, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout }));
	});
}

async function allowed(): Promise<Set<string>> {
	const { stdout } = await agx("-p", "default", "identity", "allow", "--list");
	return new Set(stdout.match(/npub1[a-z0-9]{58}/g) ?? []);
}

describe.skipIf(!existsSync(AGX))("overlapping config writes", () => {
	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "agx-e2e-config-"));
		await agx("identity", "new");
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("keeps every npub when two identity allow commands overlap", async () => {
		const asked: string[] = [];
		for (let round = 0; round < 15; round += 1) {
			const a = createIdentity().npub;
			const b = createIdentity().npub;
			asked.push(a, b);
			const runs = await Promise.all([agx("identity", "allow", a), agx("identity", "allow", b)]);
			expect(runs.map((run) => run.code)).toEqual([0, 0]);
		}
		const have = await allowed();
		expect(asked.filter((npub) => !have.has(npub))).toEqual([]);
	}, 120_000);

	it("a peer that identity deny removed stays removed when an allow overlaps it", async () => {
		const result = { stillAllowed: [] as number[], newPeerLost: [] as number[] };
		for (let round = 0; round < 25; round += 1) {
			const x = createIdentity().npub;
			const y = createIdentity().npub;
			await agx("identity", "allow", x);
			const runs = await Promise.all([agx("identity", "deny", x), agx("identity", "allow", y)]);
			expect(runs.map((run) => run.code)).toEqual([0, 0]);
			const have = await allowed();
			if (have.has(x)) {
				result.stillAllowed.push(round);
			}
			if (!have.has(y)) {
				result.newPeerLost.push(round);
			}
		}
		expect(result).toEqual({ stillAllowed: [], newPeerLost: [] });
	}, 120_000);

	it("keeps both changes when config use and identity allow overlap", async () => {
		const asked: string[] = [];
		for (let round = 0; round < 15; round += 1) {
			const npub = createIdentity().npub;
			asked.push(npub);
			const runs = await Promise.all([
				agx("config", "use", `other${round}`),
				agx("-p", "default", "identity", "allow", npub),
			]);
			expect(runs.map((run) => run.code)).toEqual([0, 0]);
		}
		const have = await allowed();
		const profiles = (await agx("-p", "default", "config", "list")).stdout;
		expect({
			missingNpubs: asked.filter((npub) => !have.has(npub)).length,
			missingProfiles: Array.from({ length: 15 }, (_, i) => `other${i}`).filter((name) => !new RegExp(`\\b${name}\\b`).test(profiles)),
		}).toEqual({ missingNpubs: 0, missingProfiles: [] });
	}, 120_000);
});

#!/usr/bin/env node
/**
 * Pack every package exactly as `pnpm publish` would and check what ships.
 *
 *   pnpm build && node scripts/check-packages.mjs
 *
 * Catches the mistakes that are invisible until someone installs a release:
 * a tarball without its license (the manifest's `license` field is not a
 * license), a `workspace:` version left in a published manifest (only
 * `pnpm publish` / `pnpm pack` rewrite those; `npm publish` does not), and an
 * n8n package that does not ship a node or credential its manifest tells n8n
 * to load, or a Tailscale package without the launcher binaries it starts.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
/** Paths are relative to the repository root. */
const REQUIRED = {
	"packages/core": ["package.json", "README.md", "LICENSE", "LICENSE-SPEC", "SPEC.md"],
	"packages/nostr": ["package.json", "README.md", "LICENSE"],
	// bin/ is not checked in: `make -C integrations/tailscale/launcher stage`
	// builds it, and the package cannot start a tailnet node without it.
	"integrations/tailscale": [
		"package.json",
		"README.md",
		"LICENSE",
		"THIRD_PARTY_NOTICES.md",
		"bin/darwin-arm64/agx-tailscale",
		"bin/darwin-x64/agx-tailscale",
		"bin/linux-arm64/agx-tailscale",
		"bin/linux-x64/agx-tailscale",
		"bin/win32-x64/agx-tailscale.exe",
	],
	"packages/cli": ["package.json", "README.md", "LICENSE"],
	"packages/n8n-nodes-agx": ["package.json", "README.md", "LICENSE"],
	"packages/n8n-nodes-agx-gateway": ["package.json", "README.md", "LICENSE"],
};

const out = mkdtempSync(join(tmpdir(), "check-packages-"));
const problems = [];
try {
	for (const [dir, required] of Object.entries(REQUIRED)) {
		const before = new Set(readdirSync(out));
		const packed = spawnSync("pnpm", ["pack", "--pack-destination", out], {
			cwd: join(root, dir),
			encoding: "utf8",
		});
		if (packed.status !== 0) {
			problems.push(`${dir}: pnpm pack failed\n${packed.stderr}`);
			continue;
		}
		const tarball = readdirSync(out).find((f) => !before.has(f));
		const list = spawnSync("tar", ["-tzf", join(out, tarball)], {
			encoding: "utf8",
		}).stdout.split("\n");
		const files = new Set(list.map((f) => f.replace(/^package\//, "")));
		for (const file of required) {
			if (!files.has(file)) {
				problems.push(`${tarball}: missing ${file}`);
			}
		}
		if (![...files].some((f) => f.startsWith("dist/"))) {
			problems.push(`${tarball}: no dist/ (run pnpm build first)`);
		}
		const manifest = spawnSync(
			"tar",
			["-xzOf", join(out, tarball), "package/package.json"],
			{ encoding: "utf8" },
		).stdout;
		if (manifest.includes("workspace:")) {
			problems.push(`${tarball}: package.json still contains a workspace: version`);
		}
		let n8n;
		try {
			n8n = JSON.parse(manifest).n8n;
		} catch {
			problems.push(`${tarball}: package.json could not be read from the tarball`);
			continue;
		}
		for (const file of [...(n8n?.nodes ?? []), ...(n8n?.credentials ?? [])]) {
			if (!files.has(file)) {
				problems.push(`${tarball}: missing ${file}, which n8n is told to load`);
			}
		}
		console.log(`${tarball}: ${files.size - 1} files`);
	}
} finally {
	rmSync(out, { recursive: true, force: true });
}

if (problems.length > 0) {
	console.error(`\n${problems.join("\n")}`);
	process.exitCode = 1;
} else {
	console.log("\nEvery package ships its license and has no workspace: versions.");
}

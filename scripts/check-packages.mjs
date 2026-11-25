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
 * to load, or a Tailscale package without the launcher binaries it starts or
 * with a POSIX launcher that is not executable.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packPackage, tarballEntries } from "./lib/pack.mjs";

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
/** Files that are spawned, so must be packed 0755 (0.7.0 shipped them 0644). */
const EXECUTABLE = {
	"integrations/tailscale": [
		"bin/darwin-arm64/agx-tailscale",
		"bin/darwin-x64/agx-tailscale",
		"bin/linux-arm64/agx-tailscale",
		"bin/linux-x64/agx-tailscale",
	],
};

const out = mkdtempSync(join(tmpdir(), "check-packages-"));
const problems = [];
try {
	for (const [dir, required] of Object.entries(REQUIRED)) {
		let tarball;
		try {
			tarball = packPackage(join(root, dir), out);
		} catch (error) {
			problems.push(`${dir}: ${error.message}`);
			continue;
		}
		const modes = new Map(
			tarballEntries(join(out, tarball)).map((entry) => [
				entry.name.replace(/^package\//, ""),
				entry.mode,
			]),
		);
		const files = new Set(modes.keys());
		for (const file of required) {
			if (!files.has(file)) {
				problems.push(`${tarball}: missing ${file}`);
			}
		}
		for (const file of EXECUTABLE[dir] ?? []) {
			if (files.has(file) && modes.get(file) !== 0o755) {
				problems.push(
					`${tarball}: ${file} is packed as ${modes.get(file).toString(8)}, not 755, so it cannot be run`,
				);
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

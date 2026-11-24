/**
 * Pack a workspace package the way it is published, and read back what a
 * tarball holds.
 *
 * `pnpm pack` is used because only pnpm rewrites `workspace:` versions, but it
 * writes every file as 0644 except the manifest's `bin` entries. The Tailscale
 * launchers under `integrations/tailscale/bin/` are spawned, not linked as
 * commands, so they lost their executable bit and 0.7.0 failed with EACCES on
 * every POSIX system. `packPackage` gives each file in the tarball the
 * executable bit it has in the working tree.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const BLOCK = 512;

/** Pack `packageDir` into `out` and return the tarball's file name. */
export function packPackage(packageDir, out) {
	const before = new Set(readdirSync(out));
	const packed = spawnSync("pnpm", ["pack", "--pack-destination", out], {
		cwd: packageDir,
		encoding: "utf8",
	});
	if (packed.status !== 0) {
		throw new Error(`pnpm pack failed in ${packageDir}:\n${packed.stderr || packed.stdout}`);
	}
	const tarball = readdirSync(out).find((file) => !before.has(file));
	if (!tarball) {
		throw new Error(`pnpm pack wrote no tarball for ${packageDir}`);
	}
	const path = join(out, tarball);
	const tar = gunzipSync(readFileSync(path));
	let changed = false;
	for (const entry of headers(tar)) {
		if (entry.type !== "0" || !entry.name.startsWith("package/")) continue;
		let source;
		try {
			source = statSync(join(packageDir, entry.name.slice("package/".length)));
		} catch {
			continue; // package.json is rewritten by pnpm; anything else is not on disk as is
		}
		// Only ever add the bit: pnpm already marks the manifest's `bin` entries
		// 0755, whatever their mode on disk.
		if (source.mode & 0o111 && entry.mode !== 0o755) {
			setMode(tar, entry.offset, 0o755);
			changed = true;
		}
	}
	if (changed) {
		writeFileSync(path, gzipSync(tar, { level: 9 }));
	}
	return tarball;
}

/** List a tarball's entries as `{ name, mode, type }`. */
export function tarballEntries(path) {
	return [...headers(gunzipSync(readFileSync(path)))].map(({ name, mode, type }) => ({
		name,
		mode,
		type,
	}));
}

function* headers(tar) {
	let offset = 0;
	let longName;
	while (offset + BLOCK <= tar.length) {
		const header = tar.subarray(offset, offset + BLOCK);
		if (header.every((byte) => byte === 0)) return;
		const size = octal(header, 124, 12);
		const type = String.fromCharCode(header[156] || 0x30);
		const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
		if (type === "x" || type === "L") {
			// pax / GNU long-name record for the next entry
			const text = body.toString("utf8");
			longName = type === "L" ? text.replace(/\0+$/, "") : /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)?.[1];
		} else {
			const prefix = string(header, 345, 155);
			const name = longName ?? (prefix ? `${prefix}/${string(header, 0, 100)}` : string(header, 0, 100));
			yield { name, mode: octal(header, 100, 8) & 0o7777, type, offset };
			longName = undefined;
		}
		offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
	}
}

function string(buffer, start, length) {
	const field = buffer.subarray(start, start + length);
	const end = field.indexOf(0);
	return field.subarray(0, end === -1 ? length : end).toString("utf8");
}

function octal(buffer, start, length) {
	const text = string(buffer, start, length).trim();
	return text ? Number.parseInt(text, 8) : 0;
}

function setMode(tar, offset, mode) {
	tar.write(`${mode.toString(8).padStart(7, "0")}\0`, offset + 100, 8, "ascii");
	tar.fill(0x20, offset + 148, offset + 156);
	let sum = 0;
	for (let i = offset; i < offset + BLOCK; i++) sum += tar[i];
	tar.write(`${sum.toString(8).padStart(6, "0")}\0 `, offset + 148, 8, "ascii");
}

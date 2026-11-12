import {
	AGX_AGENT_CARD_LIMITS,
	parseAgxAgentCardExtension,
	parseAgxAgentSkill,
} from "@nostr-agx/core";
import type {
	AgxAgentCardExtension,
	AgxAgentCardMetadataWarning,
	AgxAgentSkill,
	AgxJsonSchema,
} from "@nostr-agx/core";
import { z } from "zod";

export type AgentSkill = AgxAgentSkill;
export type AgentCardExtension = AgxAgentCardExtension;
export type AgentCardMetadataWarning = AgxAgentCardMetadataWarning;
export type AgentCardJsonSchema = AgxJsonSchema;

export const AGENT_CARD_TYPED_METADATA_LIMITS = AGX_AGENT_CARD_LIMITS;

export const SUPPORTED_AGENT_CARD_EXTENSIONS: ReadonlySet<string> = new Set();

const typedMetadataSchema = z.object({
	skills: z
		.array(z.unknown())
		.max(AGENT_CARD_TYPED_METADATA_LIMITS.skills)
		.optional(),
	extensions: z
		.array(z.unknown())
		.max(AGENT_CARD_TYPED_METADATA_LIMITS.extensions)
		.optional(),
});

export interface TypedAgentCardMetadata {
	skills?: AgentSkill[];
	extensions?: AgentCardExtension[];
	warning?: AgentCardMetadataWarning;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Size(value: unknown): number | null {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined
			? null
			: new TextEncoder().encode(serialized).byteLength;
	} catch {
		return null;
	}
}

function invalid(detail: string): TypedAgentCardMetadata {
	return {
		warning: {
			code: "invalid_typed_metadata",
			message: `Typed Agent Card metadata ignored: ${detail}`,
		},
	};
}

export function parseAgentCardMetadata(
	raw: unknown,
	supportedExtensions: ReadonlySet<string> = SUPPORTED_AGENT_CARD_EXTENSIONS,
): TypedAgentCardMetadata {
	try {
		return parseAgentCardMetadataUnsafe(raw, supportedExtensions);
	} catch {
		return invalid("metadata could not be parsed safely");
	}
}

function parseAgentCardMetadataUnsafe(
	raw: unknown,
	supportedExtensions: ReadonlySet<string>,
): TypedAgentCardMetadata {
	if (!isRecord(raw)) {
		return invalid("card content is not an object");
	}
	if (raw.skills === undefined && raw.extensions === undefined) {
		return {};
	}
	const serializedSize = utf8Size({
		...(raw.skills === undefined ? {} : { skills: raw.skills }),
		...(raw.extensions === undefined ? {} : { extensions: raw.extensions }),
	});
	if (
		serializedSize === null ||
		serializedSize > AGENT_CARD_TYPED_METADATA_LIMITS.metadataBytes
	) {
		return invalid(
			`serialized metadata exceeds ${AGENT_CARD_TYPED_METADATA_LIMITS.metadataBytes} UTF-8 bytes or is not JSON`,
		);
	}
	const parsed = typedMetadataSchema.safeParse({
		skills: raw.skills,
		extensions: raw.extensions,
	});
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
		return invalid(`${path}${issue?.message ?? "invalid metadata"}`);
	}

	const skills: AgentSkill[] = [];
	const skillIds = new Set<string>();
	for (const [index, entry] of (parsed.data.skills ?? []).entries()) {
		const result = parseAgxAgentSkill(entry);
		if ("problem" in result) {
			return invalid(`skills.${index}: ${result.problem}`);
		}
		const skill = result.skill;
		if (skillIds.has(skill.id)) {
			return invalid(`duplicate skill ID: ${skill.id}`);
		}
		skillIds.add(skill.id);
		skills.push(skill);
	}

	const extensions: AgentCardExtension[] = [];
	const extensionUris = new Set<string>();
	for (const [index, entry] of (parsed.data.extensions ?? []).entries()) {
		const result = parseAgxAgentCardExtension(entry);
		if ("problem" in result) {
			return invalid(`extensions.${index}: ${result.problem}`);
		}
		const extension = result.extension;
		if (extensionUris.has(extension.uri)) {
			return invalid(`duplicate extension URI: ${extension.uri}`);
		}
		extensionUris.add(extension.uri);
		extensions.push(extension);
	}
	const unsupportedRequired = extensions.filter(
		(extension) =>
			extension.required === true && !supportedExtensions.has(extension.uri),
	);
	const result: TypedAgentCardMetadata = {};
	if (parsed.data.extensions !== undefined) {
		result.extensions = extensions;
	}
	if (unsupportedRequired.length > 0) {
		result.warning = {
			code: "unsupported_required_extension",
			message: `Typed skills ignored because required extensions are unsupported: ${unsupportedRequired.map((extension) => extension.uri).join(", ")}`,
		};
		return result;
	}
	if (parsed.data.skills !== undefined) {
		result.skills = skills;
	}
	return result;
}

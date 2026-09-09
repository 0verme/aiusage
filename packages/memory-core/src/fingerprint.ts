import { stableHash } from "./project-identity.js";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

export function fingerprint(parts: readonly unknown[]): string {
  return stableHash(stableStringify(parts));
}

export function memoryId(kind: string, fingerprintValue: string): string {
  return `memory_${kind}_${fingerprintValue}`;
}

export function normalizeMemoryText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

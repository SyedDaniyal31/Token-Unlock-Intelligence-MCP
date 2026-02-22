/**
 * Result integrity hash: SHA256 of flat result excluding the hash field.
 * Deterministic and stable across TTL window.
 */

import { createHash } from "crypto";

const HASH_FIELD = "result_integrity_hash";

function stableStringify(obj: unknown): string {
  if (obj === null) return "null";
  if (obj === undefined) return "undefined";
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .filter((k) => k !== HASH_FIELD)
      .map((k) => JSON.stringify(k) + ":" + stableStringify((obj as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

/**
 * Compute SHA256 hex of the result object excluding result_integrity_hash.
 * Returns empty string if hashing fails (e.g. in non-Node).
 */
export function computeResultIntegrityHash(result: Record<string, unknown>): string {
  try {
    const payload = stableStringify(result);
    return createHash("sha256").update(payload, "utf8").digest("hex");
  } catch {
    return "";
  }
}

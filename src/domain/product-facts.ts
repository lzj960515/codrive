import { createHash } from "node:crypto";

import type { ProductFactsState } from "./types.js";

export function productDocumentDigest(document: string): string {
  return `sha256:${createHash("sha256").update(document).digest("hex")}`;
}

export function createProductFacts(
  document: string,
  changedAt: string,
): ProductFactsState {
  return {
    revision: 1,
    digest: productDocumentDigest(document),
    changedAt,
  };
}

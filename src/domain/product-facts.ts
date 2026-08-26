import { createHash } from "node:crypto";

import type { ProductFactsState } from "./types.js";

export function productDocumentDigest(document: string): string {
  return `sha256:${createHash("sha256").update(document).digest("hex")}`;
}

export function hasProductFacts(document: string): boolean {
  return document.trim().length > 0;
}

export function createProductFacts(
  document: string,
  changedAt: string,
): ProductFactsState {
  if (!hasProductFacts(document)) {
    throw new Error("PROJECT.md must contain product facts");
  }
  return {
    revision: 1,
    digest: productDocumentDigest(document),
    changedAt,
  };
}

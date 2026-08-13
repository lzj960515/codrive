export const MINIMUM_NODE_MAJOR = 24;

export function supportsNodeVersion(version: string): boolean {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR;
}

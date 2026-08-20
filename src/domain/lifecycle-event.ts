const auditEventPrefixes = [
  "command.",
  "recovery.",
  "app_server.",
  "workflow.",
] as const;

export function changesProjectProjection(type: string): boolean {
  return !auditEventPrefixes.some((prefix) => type.startsWith(prefix));
}

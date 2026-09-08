export type EvidenceStatus = "answered" | "partial" | "blocked" | "unreported";

/** Read only the opening status header; prose and fenced examples are ignored. */
export function evidenceStatus(text: string): EvidenceStatus {
  const match = /^(?:## Status)[ \t]*\r?\n[ \t]*(answered|partial|blocked|unreported)[ \t]*(?:\r?\n|$)/i.exec(text);
  return (match?.[1].toLowerCase() as EvidenceStatus | undefined) ?? "unreported";
}

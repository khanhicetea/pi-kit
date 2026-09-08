import { describe, expect, it } from "vitest";
import { evidenceStatus, type EvidenceStatus } from "../src/handoff.ts";

describe("evidence handoff", () => {
  it.each<[string, EvidenceStatus]>([
    ["## Status\nANSWERED\n## Answer\n- ✅", "answered"],
    ["## Status\r\npartial\r\nmore", "partial"],
    ["## Status\nblocked", "blocked"],
    ["## Status\nunreported", "unreported"],
    ["## Status\npartial extra", "unreported"],
    ["answer says ## Status\\nblocked", "unreported"],
    ["```md\n## Status\nblocked\n```", "unreported"],
    ["## Status\nnot-a-status\n## Answer\nok", "unreported"],
  ])("accepts only an opening exact status (%s)", (text, expected) => {
    expect(evidenceStatus(text)).toBe(expected);
  });
});

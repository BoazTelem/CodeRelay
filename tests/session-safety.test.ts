import { describe, expect, test } from "vitest";
import { assessExternalSession, assessReadOnlyToolIsolation } from "../src/orchestrator/session-safety.js";

const required = {
  provider: "codex" as const,
  repositoryHash: "repo",
  baseCommit: "base",
  branch: "coderelay/item",
  objectiveHash: "objective",
  taskContractHash: "contract",
  role: "WORKER" as const,
  purpose: "IMPLEMENTATION" as const
};

describe("external session quarantine", () => {
  test("allows native resumption only when every identity and restriction check matches", () => {
    const decision = assessExternalSession({
      provider: "codex", nativeSessionId: "native", repositoryHash: "repo", baseCommit: "base", branch: "coderelay/item",
      objectiveHash: "objective", taskContractHash: "contract", priorRole: "WORKER", purpose: "IMPLEMENTATION", restrictedConfigurationProven: true
    }, required);
    expect(decision).toMatchObject({ compatible: true, nativeSessionEligible: true, contextBriefOnly: false });
    expect(decision.externalSessionIdHash).not.toContain("native");
  });

  test("fails closed to Context Brief only and never promotes a Worker session to Auditor", () => {
    const decision = assessExternalSession({
      provider: "codex", nativeSessionId: "native", repositoryHash: "repo", baseCommit: "base", branch: "other",
      objectiveHash: "objective", taskContractHash: "old", priorRole: "WORKER", purpose: "IMPLEMENTATION", restrictedConfigurationProven: false
    }, { ...required, role: "AUDITOR", purpose: "REVIEW" });
    expect(decision).toMatchObject({ compatible: false, nativeSessionEligible: false, contextBriefOnly: true });
    expect(decision.reasons).toContain("a prior Worker session cannot become an independent reviewer");
  });
});

describe("fresh read-only session tool isolation", () => {
  test("accepts only the internal structured-output tool and explicitly denied attempts", () => {
    const decision = assessReadOnlyToolIsolation({
      types: [],
      toolNames: ["Bash", "Glob", "Read"],
      availableToolNames: ["StructuredOutput"],
      mcpServerStatuses: [],
      toolOutcomes: ["Bash:error", "Glob:error", "Read:error", "StructuredOutput:success"]
    });
    expect(decision).toMatchObject({
      passed: true,
      executableToolsAvailable: [],
      undeniedToolAttempts: [],
      deniedToolAttempts: ["Bash", "Glob", "Read"]
    });
  });

  test("blocks an available executable tool or an attempt without an explicit denial", () => {
    expect(assessReadOnlyToolIsolation({
      types: [], toolNames: ["Read"], availableToolNames: ["Read", "StructuredOutput"],
      mcpServerStatuses: [], toolOutcomes: ["Read:success"]
    }).passed).toBe(false);
    expect(assessReadOnlyToolIsolation({
      types: [], toolNames: ["mcp__other__read"], availableToolNames: ["StructuredOutput"],
      mcpServerStatuses: [], toolOutcomes: []
    }).passed).toBe(false);
  });
});

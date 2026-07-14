import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeClaudeAuthentication, normalizeCodexAuthentication } from "../src/providers/auth.js";
import type { CapturedProcess } from "../src/platform/services.js";
import {
  ContextBrief, FinalReport, FinalVerification, HandoffPacket, ImplementationPlan, PlanAudit,
  ProductChallenge, ProviderAuthState, ProviderCapabilities, RoleConfiguration, SCHEMA_VERSION
} from "../src/contracts/schemas.js";
import { STAGE_PROMPTS } from "../src/orchestrator/prompts.js";

function captured(stdout: string, stderr = "", exitCode = 0): CapturedProcess {
  return { executable: "fixture", args: [], stdout, stderr, exitCode, timedOut: false };
}

function jsonBlocks(markdown: string): unknown[] {
  return [...markdown.matchAll(/```json\s*([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]!));
}

describe("strict authentication normalization", () => {
  test("Codex accepts only explicit ChatGPT authentication", () => {
    expect(normalizeCodexAuthentication(captured("Logged in using ChatGPT")).state).toBe("SUBSCRIPTION_VERIFIED");
    expect(normalizeCodexAuthentication(captured("Logged in using API key")).state).toBe("API_BILLING_DETECTED");
    expect(normalizeCodexAuthentication(captured("Logged in")).state).toBe("AUTHENTICATED_BUT_MODE_UNKNOWN");
    expect(normalizeCodexAuthentication(captured("Please login", "", 1)).state).toBe("NOT_AUTHENTICATED");
  });

  test("Claude requires an explicit subscription type and rejects Console/API modes", () => {
    expect(normalizeClaudeAuthentication(captured(JSON.stringify({ loggedIn: true, subscriptionType: "Claude Max" }))).state).toBe("SUBSCRIPTION_VERIFIED");
    expect(normalizeClaudeAuthentication(captured(JSON.stringify({ loggedIn: true, authMethod: "Anthropic Console" }))).state).toBe("API_BILLING_DETECTED");
    expect(normalizeClaudeAuthentication(captured(JSON.stringify({ loggedIn: true, authMethod: "oauth" }))).state).toBe("AUTHENTICATED_BUT_MODE_UNKNOWN");
    expect(normalizeClaudeAuthentication(captured(JSON.stringify({ loggedIn: false }), "", 1)).state).toBe("NOT_AUTHENTICATED");
  });

  test("auth state enum contains the complete fail-closed vocabulary", () => {
    expect(ProviderAuthState.options).toEqual([
      "SUBSCRIPTION_VERIFIED", "API_BILLING_DETECTED", "AUTHENTICATED_BUT_MODE_UNKNOWN", "NOT_AUTHENTICATED", "PROVIDER_UNAVAILABLE"
    ]);
  });
});

describe("documentation and runtime contracts", () => {
  test("canonical JSON examples parse with runtime schemas", async () => {
    const role = jsonBlocks(await readFile(path.resolve("docs/ROLE-CONFIGURATION.md"), "utf8"));
    expect(RoleConfiguration.parse(role[0]).mode).toBe("fixed");
    const context = jsonBlocks(await readFile(path.resolve("docs/CONTEXT-ROUTING.md"), "utf8"));
    expect(ContextBrief.parse(context[0]).objective).toContain("provider status fixture");
    expect(HandoffPacket.parse(context[1]).workItemId).toBe("wi_example");
    const provider = jsonBlocks(await readFile(path.resolve("docs/PROVIDER-COMPATIBILITY.md"), "utf8"));
    expect(ProviderCapabilities.parse(provider[0]).authentication.state).toBe("SUBSCRIPTION_VERIFIED");
  });

  test("normative orchestration document includes every exact runtime prompt", async () => {
    const protocol = await readFile(path.resolve("docs/ORCHESTRATION-PROTOCOL.md"), "utf8");
    for (const prompt of Object.values(STAGE_PROMPTS)) expect(protocol).toContain(prompt);
  });

  test("prompt authority snapshot", () => {
    expect(STAGE_PROMPTS).toMatchSnapshot();
  });

  test("all stage-output and completion contracts are strict and versioned", () => {
    expect(ProductChallenge.parse({
      schemaVersion: SCHEMA_VERSION, userProblem: "problem", expectedValue: "value", existingBehavior: [], smallestUsefulScope: "scope",
      assumptions: [], risks: [], acceptanceCriteria: ["criterion"], nonGoals: [], humanQuestions: []
    }).smallestUsefulScope).toBe("scope");
    expect(ImplementationPlan.parse({
      schemaVersion: SCHEMA_VERSION, version: 1, behavior: ["behavior"], approach: "approach", reusedComponents: [], allowedPaths: ["src"], prohibitedPaths: [".git"],
      steps: [{ id: "step", description: "change", paths: ["src"], dependsOn: [] }], tests: [], validationCommands: [], risks: [], rollback: "checkpoint", humanAuthorizations: []
    }).version).toBe(1);
    expect(PlanAudit.parse({ schemaVersion: SCHEMA_VERSION, decision: "APPROVE", summary: "ok", feasibilityFindings: [], assumptionFindings: [], scopeFindings: [], testFindings: [], safetyFindings: [], requiredRevisions: [] }).decision).toBe("APPROVE");
    expect(FinalVerification.parse({ schemaVersion: SCHEMA_VERSION, decision: "APPROVE", summary: "ok", acceptanceEvidence: [], findings: [], validationRefs: [], scopeVerified: true, primaryCheckoutUntouched: true, prohibitedExternalActionsAbsent: true, pendingHumanActions: [] }).scopeVerified).toBe(true);
    expect(() => FinalReport.parse({ schemaVersion: SCHEMA_VERSION })).toThrow();
  });
});

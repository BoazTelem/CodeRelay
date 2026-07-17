import { z } from "zod";

export const CHANNELS = {
  providerStatus: "coderelay:provider-status",
  pickRepository: "coderelay:pick-repository",
  preflight: "coderelay:preflight",
  startWorkItem: "coderelay:start-work-item",
  getWorkItem: "coderelay:get-work-item",
  listWorkItems: "coderelay:list-work-items",
  pause: "coderelay:pause",
  resume: "coderelay:resume",
  intervene: "coderelay:intervene"
} as const;

export const PreflightArgs = z.object({ repository: z.string().min(1) }).strict();

export const StartWorkItemArgs = z.object({
  repository: z.string().min(1),
  instruction: z.string().min(1),
  objective: z.string().min(1).optional(),
  allowedPaths: z.array(z.string().min(1)).min(1),
  prohibitedPaths: z.array(z.string().min(1)).default([]),
  validationCommand: z.object({ executable: z.string().min(1), args: z.array(z.string()) }).strict().optional(),
  worker: z.enum(["codex", "claude"]),
  confirmedUnpushed: z.boolean().default(false)
}).strict();
export type StartWorkItemArgs = z.infer<typeof StartWorkItemArgs>;

export const WorkItemArgs = z.object({ workItemId: z.string().min(1) }).strict();

export const InterveneArgs = z.object({
  workItemId: z.string().min(1),
  instruction: z.string().min(1)
}).strict();

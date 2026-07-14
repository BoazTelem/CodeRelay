import { z } from "zod";

export const BrokerConfig = z.object({
  schemaVersion: z.literal("1.0.0"),
  workItemId: z.string().min(1),
  capabilityNonceHash: z.string().min(1),
  expiresAt: z.string().datetime(),
  root: z.string().min(1),
  approvedPaths: z.array(z.string()).min(1),
  prohibitedPaths: z.array(z.string()),
  commandRules: z.array(z.object({
    executable: z.string().min(1),
    args: z.array(z.string()),
    match: z.enum(["exact", "prefix"])
  }).strict()),
  restrictedPath: z.array(z.string()).min(1),
  tempDirectory: z.string().min(1),
  homeDirectory: z.string().optional()
}).strict();
export type BrokerConfig = z.infer<typeof BrokerConfig>;


import { z } from "zod";

const timestampSchema = z.string().datetime({ offset: true });
const identifierSchema = z.string().uuid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const climbingCloudMediaOperationSchema = z.enum(["upload", "delete"]);
export const climbingCloudMediaStatusSchema = z.enum(["pending", "confirmed", "error"]);
export const climbingCloudMediaErrorSchema = z.object({
  code: z.string().trim().min(1).max(80),
  message: z.string().trim().min(1).max(500),
  at: timestampSchema,
}).strict();

export const climbingCloudMediaItemSchema = z.object({
  referenceId: identifierSchema,
  goalId: identifierSchema,
  operation: climbingCloudMediaOperationSchema,
  status: climbingCloudMediaStatusSchema,
  sha256: digestSchema,
  byteSize: z.number().int().min(1).max(200_000_000),
  requestedAt: timestampSchema,
  updatedAt: timestampSchema,
  confirmedAt: timestampSchema.nullable(),
  error: climbingCloudMediaErrorSchema.nullable(),
}).strict().superRefine((item, ctx) => {
  if (item.status === "confirmed" && (!item.confirmedAt || item.error)) {
    ctx.addIssue({ code: "custom", message: "Confirmed cloud media needs a confirmation time and no error." });
  }
  if (item.status === "pending" && (item.confirmedAt || item.error)) {
    ctx.addIssue({ code: "custom", message: "Pending cloud media cannot include a confirmation or error." });
  }
  if (item.status === "error" && (item.confirmedAt || !item.error)) {
    ctx.addIssue({ code: "custom", message: "Failed cloud media needs an error and no confirmation time." });
  }
});

export const climbingCloudMediaReceiptSchema = z.object({
  requestId: identifierSchema,
  referenceId: identifierSchema,
  operation: climbingCloudMediaOperationSchema,
  status: climbingCloudMediaStatusSchema,
  sha256: digestSchema,
  byteSize: z.number().int().min(1).max(200_000_000),
  error: z.object({
    code: z.string().trim().min(1).max(80),
    message: z.string().trim().min(1).max(500),
  }).strict().nullable(),
}).strict().superRefine((receipt, ctx) => {
  if (receipt.status === "error" && !receipt.error) {
    ctx.addIssue({ code: "custom", path: ["error"], message: "A failed cloud media operation needs an error." });
  }
  if (receipt.status !== "error" && receipt.error) {
    ctx.addIssue({ code: "custom", path: ["error"], message: "Only a failed cloud media operation can include an error." });
  }
});

const climbingCloudMediaReceiptRecordSchema = z.object({
  requestId: identifierSchema,
  payloadHash: digestSchema,
  recordedAt: timestampSchema,
}).strict();

const climbingCloudMediaLedgerShape = {
  version: z.literal(1),
  revision: z.number().int().min(0),
  items: z.array(climbingCloudMediaItemSchema).max(10_000),
};

export const climbingCloudMediaLedgerSchema = z.object({
  ...climbingCloudMediaLedgerShape,
  receipts: z.array(climbingCloudMediaReceiptRecordSchema).max(500),
}).strict().refine(state => new Set(state.items.map(item => item.referenceId)).size === state.items.length, "Cloud media reference IDs must be unique.")
  .refine(state => new Set(state.receipts.map(receipt => receipt.requestId)).size === state.receipts.length, "Cloud media receipt IDs must be unique.");

export const climbingCloudMediaViewSchema = z.object(climbingCloudMediaLedgerShape).strict()
  .refine(state => new Set(state.items.map(item => item.referenceId)).size === state.items.length, "Cloud media reference IDs must be unique.");

export type ClimbingCloudMediaItem = z.infer<typeof climbingCloudMediaItemSchema>;
export type ClimbingCloudMediaLedger = z.infer<typeof climbingCloudMediaLedgerSchema>;
export type ClimbingCloudMediaReceipt = z.infer<typeof climbingCloudMediaReceiptSchema>;
export type ClimbingCloudMediaView = z.infer<typeof climbingCloudMediaViewSchema>;

export const emptyClimbingCloudMedia: ClimbingCloudMediaLedger = {
  version: 1,
  revision: 0,
  items: [],
  receipts: [],
};

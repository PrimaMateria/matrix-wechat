import { z } from "zod";
import { APIError } from "./types";

export const apiRequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional().default({}),
});
export type APIRequest = z.infer<typeof apiRequestSchema>;

export const textMessageSchema = z.object({
  kind: z.literal("text"),
  chat_id: z.string().min(1).max(256),
  text: z.string().refine((value) => value.trim().length > 0 && Buffer.byteLength(value) <= 65536),
  reply_to: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
});

export const loginRequestSchema = z.object({ mode: z.enum(["saved", "qr"]) });

export function validateParams<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new APIError("invalid_params", "Invalid request parameters");
  return result.data;
}

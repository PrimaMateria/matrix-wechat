import { z } from "zod";

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

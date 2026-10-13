import { z } from "zod";
import { APIError } from "./types";

export const apiRequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional().default({}),
});
export type APIRequest = z.infer<typeof apiRequestSchema>;

export { loginRequestSchema, textMessageSchema } from "wechat-rpc/schemas";

export function validateParams<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new APIError("invalid_params", "Invalid request parameters");
  return result.data;
}

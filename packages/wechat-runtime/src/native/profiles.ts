import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-f]+$/i);
const instructionBytes = z.string().regex(/^(?:[0-9a-f]{2})+$/i);
const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const storageProfileSchema = z
  .object({
    schema_version: z.literal(1),
    artifact: z.object({ sha256: hash, appimage_sha256: hash }).passthrough(),
    functions: z.record(z.string(), address),
    validation_bytes: z.record(z.string(), instructionBytes),
    compression: z
      .object({
        scalar_name: z.string().min(1),
        argument_count: z.int().positive(),
        sqlite_encoding_flags: z.int().nonnegative(),
        scalar_callback_rva: address,
      })
      .passthrough(),
  })
  .passthrough();

export const outboundProfileSchema = z
  .object({
    format_version: z.literal(1),
    elf_sha256: hash,
    functions: z.record(z.string(), z.object({ rva: address, validation_bytes: instructionBytes })),
  })
  .passthrough();

export type StorageProfile = z.infer<typeof storageProfileSchema>;
export type OutboundProfile = z.infer<typeof outboundProfileSchema>;

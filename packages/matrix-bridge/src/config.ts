import { z } from "zod";

export const configSchema = z.object({
  homeserver: z.object({ address: z.url(), domain: z.string().min(1) }).strict(),
  appservice: z.object({
    address: z.url(),
    hostname: z.string().default("0.0.0.0"),
    port: z.number().int().min(1).max(65535).default(17778),
    bot_username: z.string().regex(/^[a-z0-9_]+$/).default("wechatbot"),
    registration: z.string().default("/data/registration.yaml"),
  }).strict(),
  bridge: z.object({
    owner: z.string().regex(/^@[^:]+:.+$/),
    command_prefix: z.string().min(1).default("!wechat"),
  }).strict(),
  database: z.object({ path: z.string().default("/data/matrix-wechat.db") }).strict().default({ path: "/data/matrix-wechat.db" }),
  network: z.object({
    backend: z.enum(["native", "fake"]).default("native"),
    fixture: z.string().default("fixtures/demo.json"),
  }).strict().default({ backend: "native", fixture: "fixtures/demo.json" }),
}).strict();
export type Config = z.infer<typeof configSchema>;
export async function loadConfig(path: string): Promise<Config> {
  return configSchema.parse(Bun.YAML.parse(await Bun.file(path).text()));
}

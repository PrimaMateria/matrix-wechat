import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const { parse, stringify } = Bun.YAML;

export interface Config {
  homeserver: { address: string; domain: string };
  appservice: {
    address: string;
    hostname: string;
    port: number;
    id: string;
    bot: string;
    prefix: string;
    as_token: string;
    hs_token: string;
  };
  bridge: {
    owner: string;
    database: string;
    command_prefix: string;
    max_media_size: number;
    history_batch_size: number;
    reconcile_seconds: number;
  };
  web: { hostname: string; port: number };
  network: { backend: "wechat" | "fake"; fixture?: string };
}
export const defaults: Config = {
  homeserver: { address: "http://synapse:8008", domain: "example.com" },
  appservice: {
    address: "http://bridge:17778",
    hostname: "0.0.0.0",
    port: 17778,
    id: "wechat",
    bot: "wechatbot",
    prefix: "wechat_",
    as_token: "",
    hs_token: "",
  },
  bridge: {
    owner: "@you:example.com",
    database: "/data/bridge.db",
    command_prefix: "!wechat",
    max_media_size: 50 * 1024 * 1024,
    history_batch_size: 200,
    reconcile_seconds: 60,
  },
  web: { hostname: "0.0.0.0", port: 18742 },
  network: { backend: "wechat" },
};
export async function privateFile(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + ".tmp-" + randomBytes(8).toString("hex");
  await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
export async function loadConfig(path: string): Promise<Config> {
  const input = parse(await Bun.file(path).text()) as Record<string, any>;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("Configuration must be a mapping");
  const config = Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [key, { ...value, ...input[key] }]),
  ) as unknown as Config;
  for (const url of [config.homeserver.address, config.appservice.address]) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
      throw Error("Invalid homeserver/appservice URL");
  }
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(config.homeserver.domain))
    throw Error("Invalid homeserver domain");
  if (!/^@[^:\s]+:[^\s]+$/.test(config.bridge.owner))
    throw Error("bridge.owner must be a full Matrix user ID");
  if (
    !/^[a-z0-9_=-]+$/.test(config.appservice.bot) ||
    !/^[a-z0-9_=-]+$/.test(config.appservice.prefix)
  )
    throw Error("Invalid bot or ghost prefix");
  if (config.appservice.bot.startsWith(config.appservice.prefix))
    throw Error("Bot must be outside the ghost prefix");
  if (!["wechat", "fake"].includes(config.network.backend))
    throw Error("network.backend must be wechat or fake");
  for (const port of [config.appservice.port, config.web.port])
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid listener port");
  if (config.appservice.port === config.web.port)
    throw Error("Bridge and web UI need different ports");
  for (const [value, min, max] of [
    [config.bridge.max_media_size, 1, 64 * 1024 * 1024],
    [config.bridge.history_batch_size, 1, 500],
    [config.bridge.reconcile_seconds, 5, 86400],
  ])
    if (!Number.isInteger(value) || value < min || value > max) throw Error("Invalid bridge limit");
  if (typeof config.bridge.database !== "string" || !config.bridge.database)
    throw Error("A SQLite database path is required");
  if (typeof config.bridge.command_prefix !== "string" || !config.bridge.command_prefix.trim())
    throw Error("A command prefix is required");
  return config;
}
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export async function generateRegistration(
  config: Config,
  configPath: string,
  registrationPath: string,
) {
  config.appservice.as_token ||= randomBytes(32).toString("hex");
  config.appservice.hs_token ||= randomBytes(32).toString("hex");
  await privateFile(configPath, stringify(config));
  await privateFile(
    registrationPath,
    stringify({
      id: config.appservice.id,
      url: config.appservice.address,
      as_token: config.appservice.as_token,
      hs_token: config.appservice.hs_token,
      sender_localpart: config.appservice.bot,
      rate_limited: false,
      namespaces: {
        users: [
          {
            exclusive: true,
            regex: `^@${escapeRegex(config.appservice.prefix)}[a-f0-9]+:${escapeRegex(config.homeserver.domain)}$`,
          },
        ],
        aliases: [
          {
            exclusive: true,
            regex: `^#${escapeRegex(config.appservice.prefix)}[a-f0-9]+:${escapeRegex(config.homeserver.domain)}$`,
          },
        ],
        rooms: [],
      },
    }),
  );
}

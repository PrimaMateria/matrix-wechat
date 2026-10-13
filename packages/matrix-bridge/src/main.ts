import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { createHandler } from "../../wechatlinux/src/server";
import { WeChatBridge } from "./bridge";
import { defaults, generateRegistration, loadConfig, privateFile } from "./config";
import { Store } from "./db";
import { FakeSession, type Fixture, WeChatSession } from "./session";

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c", default: "config.yaml" },
      registration: { type: "string", short: "r", default: "registration.yaml" },
      "generate-config": { type: "boolean", short: "e" },
      "generate-registration": { type: "boolean", short: "g" },
      version: { type: "boolean" },
    },
  });
  if (values.version) {
    console.log("matrix-wechat TypeScript / Bun");
    return;
  }
  const configPath = values.config!;
  if (values["generate-config"]) {
    if (existsSync(configPath)) throw Error("Configuration already exists");
    await privateFile(configPath, Bun.YAML.stringify(defaults));
    console.log("Wrote configuration:", configPath);
    return;
  }
  const config = await loadConfig(configPath);
  if (values["generate-registration"]) {
    await generateRegistration(config, configPath, values.registration!);
    console.log("Wrote registration:", values.registration);
    return;
  }
  if (!config.appservice.as_token || !config.appservice.hs_token)
    throw Error("Generate registration first with -g -c config.yaml -r registration.yaml");
  let session: WeChatSession | FakeSession, backend;
  if (config.network.backend === "fake") {
    if (!config.network.fixture) throw Error("network.fixture is required for the fake backend");
    session = new FakeSession((await Bun.file(config.network.fixture).json()) as Fixture);
    backend = session;
  } else {
    const { Runtime } = await import("../../wechatlinux/src/runtime");
    const runtime = new Runtime();
    session = new WeChatSession(runtime);
    backend = runtime;
  }
  const store = new Store(config.bridge.database),
    bridge = new WeChatBridge(config, store, session);
  const web = Bun.serve({
    hostname: config.web.hostname,
    port: config.web.port,
    idleTimeout: 0,
    fetch: createHandler(backend),
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await web.stop(true);
    await bridge.close();
    store.close();
  };
  process.on("SIGTERM", () => void close().then(() => process.exit(0)));
  process.on("SIGINT", () => void close().then(() => process.exit(0)));
  try {
    await bridge.start();
    console.log(
      `Matrix appservice: ${config.appservice.port}; WeChat web UI: http://localhost:${config.web.port}/`,
    );
  } catch (error) {
    await close();
    throw error;
  }
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });

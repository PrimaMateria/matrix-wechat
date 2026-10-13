import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AppServiceRegistration } from "matrix-appservice-bridge";
import { privateAPI } from "../../wechat-runtime/src/private-api";
import { createHandler } from "../../wechat-runtime/src/server";
import { WeChatBridge } from "./bridge";
import { loadConfig } from "./config";
import { generateRegistration, Matrix } from "./matrix";
import { capabilities } from "./messages";
import { Store } from "./store";

const version = "0.1.0";
export async function main(args = Bun.argv.slice(2)) {
  process.umask(0o077);
  let configPath = "config.yaml",
    registrationPath: string | undefined;
  let generate = false,
    example = false,
    check = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--version") {
      console.log(`matrix-wechat ${version} (Bun ${Bun.version})`);
      return;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        "matrix-wechat [-c config.yaml] [-r registration.yaml] [-g | -e | --check-config | --version]",
      );
      return;
    }
    if (arg === "-c" || arg === "--config") {
      if (!args[index + 1]) throw new Error("Configuration path is required");
      configPath = args[++index];
    } else if (arg === "-r" || arg === "--registration") {
      if (!args[index + 1]) throw new Error("Registration path is required");
      registrationPath = args[++index];
    } else if (arg === "-g") generate = true;
    else if (arg === "-e") example = true;
    else if (arg === "--check-config") check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (example || !(await Bun.file(configPath).exists())) {
    if (await Bun.file(configPath).exists())
      throw new Error("Refusing to overwrite existing configuration");
    await Bun.write(configPath, Bun.file(new URL("../../../example-config.yaml", import.meta.url)));
    await chmod(configPath, 0o600);
    console.log(
      `Example configuration written to ${configPath}. Set homeserver details and bridge.owner, then generate registration with -g.`,
    );
    return;
  }
  const config = await loadConfig(configPath);
  if (registrationPath) config.appservice.registration = registrationPath;
  if (check) {
    console.log("Configuration is valid");
    return;
  }
  if (generate) {
    if (await Bun.file(config.appservice.registration).exists())
      throw new Error("Refusing to overwrite existing registration and tokens");
    await Bun.write(
      config.appservice.registration,
      Bun.YAML.stringify(generateRegistration(config).getOutput()),
    );
    await chmod(config.appservice.registration, 0o600);
    console.log(
      `Registration written to ${config.appservice.registration}. Register it with your homeserver and restart the homeserver.`,
    );
    return;
  }
  if (!(await Bun.file(config.appservice.registration).exists()))
    throw new Error(
      "Generate registration with -g, register it with your homeserver, then start the bridge",
    );
  const registration = AppServiceRegistration.fromObject(
    Bun.YAML.parse(await Bun.file(config.appservice.registration).text()) as any,
  );
  if (registration.getSenderLocalpart() !== config.appservice.bot_username)
    throw new Error("Registration bot does not match configuration");
  await mkdir(dirname(config.database.path), { recursive: true, mode: 0o700 });
  const store = new Store(config.database.path);
  await chmod(config.database.path, 0o600);
  const { Runtime } = await import("../../wechat-runtime/src/runtime");
  const runtime = new Runtime();
  let engine: WeChatBridge;
  const matrix = new Matrix(
    config,
    registration,
    (event) => engine.accept(event),
    (mxid) => Boolean(store.get("SELECT mxid FROM ghosts WHERE mxid=?", mxid)),
  );
  let web: ReturnType<typeof Bun.serve> | undefined;
  let closePrivate: (() => Promise<void>) | undefined;
  let closing = false;
  const close = async (failed = false) => {
    if (closing) return;
    closing = true;
    await engine?.stop();
    await closePrivate?.();
    await runtime.close();
    await web?.stop(true);
    await matrix.close();
    store.close();
    process.exit(failed ? 1 : 0);
  };
  engine = new WeChatBridge(config, runtime, matrix, store, () => {
    console.error("Native client disconnected; restarting deployment");
    void close(true);
  });
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());
  try {
    await matrix.start();
    web = Bun.serve({
      hostname: "0.0.0.0",
      port: 18742,
      idleTimeout: 0,
      fetch: createHandler(runtime),
    });
    closePrivate = await privateAPI(runtime);
    await runtime.start();
    await engine.start();
    console.log("Matrix–WeChat bridge ready. Management room invites go to the configured owner.");
    console.log(`Supported sends: ${capabilities.sending.join(", ")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Startup failed");
    await close(true);
    throw error;
  }
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Startup failed");
    process.exitCode = 1;
  });

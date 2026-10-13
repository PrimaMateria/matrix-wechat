// Real Podman/Synapse/WeChat E2E. Outgoing tests target File Transfer only.
import { history } from "./e2e/history";
import { encryption, permissions } from "./e2e/permissions";
import { outage, restart } from "./e2e/recovery";
import { media, quote, text } from "./e2e/send";
import { close, directory, setup } from "./e2e/stack";

const cases = {
  history,
  text,
  quote,
  image: () => media("image"),
  file: () => media("file"),
  video: () => media("video"),
  restart,
  outage,
  permissions,
  encryption,
};
const args = Bun.argv.slice(2);
const requested = args.filter((arg) => arg !== "--build");
if (requested.includes("--help")) {
  console.log(`Usage: bun run test:matrix [${Object.keys(cases).join("|")}|all] [--build]`);
  process.exit(0);
}
const selected = requested.length && !requested.includes("all") ? requested : Object.keys(cases);
for (const name of selected) if (!(name in cases)) throw new Error(`Unknown E2E case: ${name}`);
const results: Record<string, unknown> = {};
try {
  await setup(
    args.includes("--build"),
    selected.some((name) => ["history", "image", "file", "video"].includes(name)),
  );
  for (const name of selected) {
    console.log(`E2E: ${name}`);
    results[name] = { passed: true, ...(await cases[name as keyof typeof cases]()) };
  }
  await Bun.write(
    `${directory}/proof.json`,
    JSON.stringify({ verified_at: new Date().toISOString(), results }, null, 2),
  );
  console.log(`Passed: ${selected.join(", ")}`);
} finally {
  await close();
}

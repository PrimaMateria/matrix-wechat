import { XMLParser } from "fast-xml-parser";
import { PNG } from "pngjs";

type Node = {
  text?: string;
  "content-desc"?: string;
  package?: string;
  clickable?: string;
  enabled?: string;
  bounds?: string;
  node?: Node | Node[];
};
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
const loginButton = /^(log\s*in|login|登录|登入|登錄)$/i;
const desktopPrompt =
  /(?:log\s*in|login|登录|登入|登錄).*(?:desktop|linux|windows|mac|computer|电脑|電腦)|(?:desktop|linux|windows|mac|computer|电脑|電腦).*(?:log\s*in|login|登录|登入|登錄)/i;

export function confirmationButton(xml: string): [number, number] | undefined {
  const root = parser.parse(xml).hierarchy;
  const nodes: { node: Node; parent?: Node }[] = [];
  function visit(node: Node, parent?: Node) {
    nodes.push({ node, parent });
    for (const child of Array.isArray(node.node) ? node.node : node.node ? [node.node] : [])
      visit(child, node);
  }
  for (const node of Array.isArray(root?.node) ? root.node : root?.node ? [root.node] : [])
    visit(node);
  const wechat = nodes.filter(({ node }) => node.package === "com.tencent.mm");
  if (
    !wechat.some(({ node }) =>
      desktopPrompt.test(`${node.text || ""} ${node["content-desc"] || ""}`),
    )
  )
    return;
  for (const { node, parent } of wechat) {
    if (!loginButton.test((node.text || node["content-desc"] || "").trim())) continue;
    const target = node.clickable === "true" ? node : parent;
    if (
      target?.package !== "com.tencent.mm" ||
      target.enabled === "false" ||
      target.clickable !== "true"
    )
      continue;
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(target.bounds || "");
    if (!bounds) continue;
    const [, left, top, right, bottom] = bounds.map(Number);
    if (right > left && bottom > top)
      return [Math.floor((left + right) / 2), Math.floor((top + bottom) / 2)];
  }
}

export function greenLoginButton(png: PNG): [number, number] | undefined {
  const { width, height, data } = png;
  const bands: { left: number; right: number; top: number; bottom: number }[] = [];
  for (let y = Math.floor(height * 0.6); y < height * 0.88; y++) {
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const i = (y * width + x) * 4;
      const green =
        x < width && data[i] < 60 && data[i + 1] > 150 && data[i + 2] > 50 && data[i + 2] < 170;
      if (green && start < 0) start = x;
      if (green || start < 0) continue;
      if (x - start > width * 0.25) {
        const last = bands.at(-1);
        if (last && y - last.bottom < height * 0.03 && Math.abs(start - last.left) < width * 0.1) {
          last.left = Math.min(last.left, start);
          last.right = Math.max(last.right, x);
          last.bottom = y;
        } else bands.push({ left: start, right: x, top: y, bottom: y });
      }
      start = -1;
    }
  }
  const buttons = bands.filter(
    (b) => b.bottom - b.top > height * 0.02 && b.bottom - b.top < height * 0.12,
  );
  if (buttons.length === 1) {
    const b = buttons[0];
    return [Math.floor((b.left + b.right) / 2), Math.floor((b.top + b.bottom) / 2)];
  }
}

async function adbBytes(...args: string[]): Promise<Buffer> {
  const child = Bun.spawn(["adb", ...args], { stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 15000);
  try {
    const [output, , code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw Error("ADB command failed; check the connected phone");
    return Buffer.from(output);
  } finally {
    clearTimeout(timeout);
  }
}
async function adb(...args: string[]) {
  return (await adbBytes(...args)).toString();
}

async function desktopLoginActivity() {
  return /topResumedActivity=[^\n]*com\.tencent\.mm\/\.plugin\.webwx\.ui\.ExtDeviceWXLoginUI\b/.test(
    await adb("shell", "dumpsys", "activity", "activities"),
  );
}

async function confirm() {
  const trust = await adb("shell", "dumpsys", "trust");
  if (/\(current\):[^\n]*deviceLocked=1/.test(trust))
    return "Unlock the phone to allow login confirmation";
  await adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  await adb("shell", "wm", "dismiss-keyguard");
  const window = await adb("shell", "dumpsys", "window");
  if (!/(?:mCurrentFocus|mFocusedApp)=[^\n]*com\.tencent\.mm\//.test(window))
    await adb("shell", "am", "start", "-W", "-n", "com.tencent.mm/.ui.LauncherUI");
  const path = `/data/local/tmp/wechat-login-${crypto.randomUUID()}.xml`;
  try {
    await adb("shell", "uiautomator", "dump", path);
    let point = confirmationButton(await adb("exec-out", "cat", path));
    if (!point && (await desktopLoginActivity())) {
      const png = PNG.sync.read(await adbBytes("exec-out", "screencap", "-p"));
      point = greenLoginButton(png);
      if (!(await desktopLoginActivity())) return "Waiting for the WeChat desktop login prompt";
    }
    if (!point) return "Waiting for the WeChat desktop login prompt";
    await adb("shell", "input", "tap", String(point[0]), String(point[1]));
    return "Pressed WeChat desktop login confirmation";
  } finally {
    await adb("shell", "rm", "-f", path).catch(() => {});
  }
}

if (import.meta.main) {
  const watch = Bun.argv.includes("--watch");
  let previous = "";
  do {
    try {
      const response = await fetch("http://127.0.0.1:18742/api/status", {
        signal: AbortSignal.timeout(3000),
      });
      const status = (await response.json()) as { state: string };
      const message =
        status.state === "awaiting_confirmation" ? await confirm() : `WeChat: ${status.state}`;
      if (message !== previous) console.log(message);
      previous = message;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Waiting for WeChat";
      if (message !== previous) console.log(message);
      previous = message;
    }
    if (watch) await Bun.sleep(3000);
  } while (watch);
}

import { expect, test } from "bun:test";
import { confirmationButton } from "../scripts/adb-login";

function prompt(title: string, packageName = "com.tencent.mm") {
  return `<hierarchy><node package="${packageName}" text="${title}"><node package="${packageName}" text="Log In" enabled="true" clickable="true" bounds="[100,400][300,500]" /></node></hierarchy>`;
}

test("only confirms a WeChat desktop login prompt", () => {
  expect(confirmationButton(prompt("Log In to WeChat for Linux"))).toEqual([200, 450]);
  expect(confirmationButton(prompt("Sign in to your account"))).toBeUndefined();
  expect(confirmationButton(prompt("Log In to WeChat for Linux", "example.app"))).toBeUndefined();
});

test("supports a login label inside its clickable parent", () => {
  const xml = `<hierarchy><node package="com.tencent.mm" text="登录电脑微信"><node package="com.tencent.mm" clickable="true" enabled="true" bounds="[10,20][110,80]"><node package="com.tencent.mm" text="登录" clickable="false" /></node></node></hierarchy>`;
  expect(confirmationButton(xml)).toEqual([60, 50]);
});

test("image fallback ignores small green controls and rejects ambiguous buttons", async () => {
  const { PNG } = await import("pngjs");
  const { greenLoginButton } = await import("../scripts/adb-login");
  const image = new PNG({ width: 200, height: 400 });
  function rectangle(left: number, top: number, right: number, bottom: number) {
    for (let y = top; y < bottom; y++)
      for (let x = left; x < right; x++) {
        const i = (y * image.width + x) * 4;
        image.data.set([7, 193, 96, 255], i);
      }
  }
  rectangle(20, 265, 26, 271);
  expect(greenLoginButton(image)).toBeUndefined();
  rectangle(50, 295, 150, 320);
  expect(greenLoginButton(image)).toEqual([100, 307]);
  rectangle(50, 330, 150, 349);
  expect(greenLoginButton(image)).toBeUndefined();
});

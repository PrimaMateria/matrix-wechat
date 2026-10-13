import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import type { Router } from "./router";
import { APIError } from "./types";

export * from "./types";
export function errorCode(error: unknown): string | undefined {
  if (error instanceof APIError) return error.code;
  if (error instanceof TRPCClientError) {
    const data = error.data as TRPCClientError<Router>["data"];
    return data?.runtimeCode || (data?.code === "BAD_REQUEST" ? "invalid_params" : undefined);
  }
}
export function createClient(address: string, token: string) {
  const url = address.replace(/\/$/, "");
  const controller = new AbortController();
  const headers = { Authorization: `Bearer ${token}` };
  const rpc = createTRPCClient<Router>({
    links: [
      httpLink({
        url: `${url}/trpc`,
        headers,
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
          }),
      }),
    ],
  });
  return {
    rpc,
    close: () => controller.abort(),
    async asset(
      kind: "avatar" | "media" | "thumbnail" | "qr",
      params: Record<string, string> = {},
    ) {
      const response = await fetch(`${url}/assets/${kind}?${new URLSearchParams(params)}`, {
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        const result = (await response.json()) as { error: { code: string; message: string } };
        throw new APIError(result.error.code, result.error.message);
      }
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        type: response.headers.get("Content-Type") || "application/octet-stream",
        name: response.headers.get("X-Filename")
          ? decodeURIComponent(response.headers.get("X-Filename")!)
          : undefined,
      };
    },
    upload(chat: string, bytes: Buffer, name: string, kind: "image" | "file") {
      const form = new FormData();
      form.set("chat", chat);
      form.set("kind", kind);
      form.set("file", new File([new Uint8Array(bytes)], name));
      return rpc.upload.mutate(form);
    },
  };
}
export type WeChatClient = ReturnType<typeof createClient>;

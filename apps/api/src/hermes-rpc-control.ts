import type { ApiConfig } from "./config";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export type HermesControlScope = {
  accountId: string;
  workspaceId: string;
  runtimeCellId: string;
};

async function controlUrl(config: ApiConfig, scope: HermesControlScope): Promise<string> {
  const url = new URL(`${config.hermesManagerUrl}/internal/gateway/connection`);
  url.searchParams.set("profile", "default");
  url.searchParams.set("account_id", scope.accountId);
  url.searchParams.set("workspace_id", scope.workspaceId);
  url.searchParams.set("runtime_cell_id", scope.runtimeCellId);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${config.hermesManagerServiceToken}` },
  });
  const body = await response.json() as { wsUrl?: string; error?: string };
  if (!response.ok || !body.wsUrl) {
    throw new Error(body.error || `Hermes control connection failed with ${response.status}`);
  }
  return body.wsUrl;
}

export async function requestHermesControl<T>(
  config: ApiConfig,
  scope: HermesControlScope,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const socket = new WebSocket(await controlUrl(config, scope), { maxPayload: 4 * 1024 * 1024 });
  const id = randomUUID();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Hermes control WebSocket connection timed out")), 15_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Hermes control request timed out: ${method}`)), 15_000);
      socket.on("message", (raw, binary) => {
        if (binary) return;
        let frame: { id?: string; result?: T; error?: { message?: string } };
        try {
          frame = JSON.parse(raw.toString()) as typeof frame;
        } catch {
          return;
        }
        if (frame.id !== id) return;
        clearTimeout(timer);
        if (frame.error) reject(new Error(frame.error.message || `Hermes RPC failed: ${method}`));
        else resolve(frame.result as T);
      });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, "control_request_complete");
    }
  }
}

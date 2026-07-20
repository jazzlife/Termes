import type { ApiConfig } from "./config";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { FastifyRequest } from "fastify";
import type { AccountPrincipal } from "./account-auth";
import { z } from "zod";

function managerHeaders(config: ApiConfig): Record<string, string> {
  return { authorization: `Bearer ${config.hermesManagerServiceToken}` };
}

async function managerJson(config: ApiConfig, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${config.hermesManagerUrl}${path}`, {
    ...init,
    headers: { ...managerHeaders(config), ...(init.headers || {}) },
  });
}

async function proxyJson(reply: FastifyReply, response: Response) {
  const body = response.status === 204 ? null : await response.json();
  if (response.status === 204) {
    return reply.code(204).send();
  }
  return reply.code(response.status).send(body);
}

export async function registerOpenAiAuth(
  app: FastifyInstance,
  config: ApiConfig,
  principalForRequest: (request: FastifyRequest) => AccountPrincipal,
): Promise<void> {
  const requireAdmin = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (principalForRequest(request).accountId === config.oauthAdminAccountId) return true;
    reply.code(403).send({ error: "Only the OAuth authority administrator may change the shared login" });
    return false;
  };

  app.post("/api/openai-auth/device-sessions", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const response = await managerJson(config, "/internal/openai-auth/device-sessions", { method: "POST" });
    return proxyJson(reply, response);
  });

  app.get("/api/openai-auth/device-sessions/:sessionId", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    const response = await managerJson(
      config,
      `/internal/openai-auth/device-sessions/${encodeURIComponent(sessionId)}`,
    );
    return proxyJson(reply, response);
  });

  app.delete("/api/openai-auth/device-sessions/:sessionId", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    const response = await managerJson(
      config,
      `/internal/openai-auth/device-sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
    return proxyJson(reply, response);
  });

  app.get("/api/openai-auth/account", async (_request, reply) => {
    const response = await managerJson(config, "/internal/openai-auth/account");
    return proxyJson(reply, response);
  });

  app.post("/api/openai-auth/logout", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const response = await managerJson(config, "/internal/openai-auth/logout", { method: "POST" });
    return proxyJson(reply, response);
  });
}

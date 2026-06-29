import cors from "@fastify/cors";
import type {
  AgentRunSummary,
  ArtifactSummary,
  CheckpointSummary,
  EventType,
  HermesCapabilitySummary,
  PlatformEvent,
  ProjectSummary,
  RuntimeSessionSummary,
  TaskRuntimeSummary,
  TaskStatus,
  TaskSummary,
} from "@termes/shared";
import { TERMES_VERSION, assertTaskStatus } from "@termes/shared";
import Fastify from "fastify";
import Redis from "ioredis";
import { z } from "zod";
import { loadConfig } from "./config";
import { assertDbReady, createDb } from "./db";
import { EVENT_CHANNEL, appendEvent } from "./events";

const projectInputSchema = z.object({
  key: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional(),
});

const taskInputSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(2).max(180),
  instructions: z.string().trim().min(1).max(10000),
});

function mapProject(row: {
  id: string;
  key: string;
  name: string;
  description: string | null;
  created_at: Date;
}): ProjectSummary {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    createdAt: row.created_at.toISOString(),
  };
}

function mapTask(row: {
  id: string;
  project_id: string;
  title: string;
  instructions: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}): TaskSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    instructions: row.instructions,
    status: assertTaskStatus(row.status),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapSession(row: {
  id: string;
  task_id: string;
  runtime_profile_id: string | null;
  hermes_session_id: string | null;
  hermes_run_id: string | null;
  created_at: Date;
  updated_at: Date;
}): RuntimeSessionSummary {
  return {
    id: row.id,
    taskId: row.task_id,
    runtimeProfileId: row.runtime_profile_id,
    hermesSessionId: row.hermes_session_id,
    hermesRunId: row.hermes_run_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapRun(row: {
  id: string;
  task_id: string;
  soul_id: string | null;
  runtime_session_id: string | null;
  status: AgentRunSummary["status"];
  branch_name: string | null;
  worktree_path: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): AgentRunSummary {
  return {
    id: row.id,
    taskId: row.task_id,
    soulId: row.soul_id,
    runtimeSessionId: row.runtime_session_id,
    status: row.status,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    startedAt: row.started_at?.toISOString() || null,
    completedAt: row.completed_at?.toISOString() || null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapCheckpoint(row: {
  id: string;
  task_id: string;
  agent_run_id: string | null;
  summary: string;
  git_commit_sha: string | null;
  snapshot_uri: string | null;
  checksum: string | null;
  changed_files: unknown;
  test_result: Record<string, unknown>;
  created_at: Date;
}): CheckpointSummary {
  return {
    id: row.id,
    taskId: row.task_id,
    agentRunId: row.agent_run_id,
    summary: row.summary,
    gitCommitSha: row.git_commit_sha,
    snapshotUri: row.snapshot_uri,
    checksum: row.checksum,
    changedFiles: Array.isArray(row.changed_files) ? row.changed_files : [],
    testResult: row.test_result,
    createdAt: row.created_at.toISOString(),
  };
}

function mapArtifact(row: {
  id: string;
  project_id: string | null;
  task_id: string | null;
  kind: string;
  uri: string;
  checksum: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}): ArtifactSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    kind: row.kind,
    uri: row.uri,
    checksum: row.checksum,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

function mapEvent(row: {
  id: string;
  project_id: string | null;
  task_id: string | null;
  type: EventType;
  payload: Record<string, unknown>;
  created_at: Date;
}): PlatformEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}

function encodeSse(event: string, data: unknown, id?: string): string {
  const lines = [`event: ${event}`, `data: ${JSON.stringify(data)}`];
  if (id) {
    lines.unshift(`id: ${id}`);
  }

  return `${lines.join("\n")}\n\n`;
}

function proxyHeaders(headers: Record<string, string | string[] | undefined>): HeadersInit {
  const forwarded: Record<string, string> = {};
  for (const name of ["accept", "idempotency-key", "x-hermes-session-id", "x-hermes-session-key"]) {
    const value = headers[name];
    if (Array.isArray(value)) {
      forwarded[name] = value[0] || "";
    } else if (value) {
      forwarded[name] = value;
    }
  }

  return forwarded;
}

function proxyRequestInit(
  method: string,
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
): RequestInit {
  if (method === "GET" || method === "HEAD") {
    return { method, headers: proxyHeaders(headers) };
  }

  return {
    method,
    headers: { "content-type": "application/json", ...proxyHeaders(headers) },
    body: JSON.stringify(body || {}),
  };
}

function hermesProxyPath(url: string): string {
  const path = url.replace(/^\/api\/hermes/, "");
  return path || "/";
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  });

  await redis.connect();

  const app = Fastify({
    logger: true,
    requestTimeout: 30_000,
  });

  await app.register(cors, {
    origin: true,
  });

  app.addHook("onClose", async () => {
    redis.disconnect();
    await db.close();
  });

  async function healthPayload() {
    await assertDbReady(db.pool);
    await redis.ping();

    return {
      service: "api",
      version: TERMES_VERSION,
      status: "ok",
      checkedAt: new Date().toISOString(),
      dependencies: {
        postgres: "ok",
        redis: "ok",
      },
    };
  }

  app.get("/healthz", healthPayload);
  app.get("/api/health", healthPayload);
  app.get("/api/healthz", healthPayload);

  app.get("/api/projects", async () => {
    const result = await db.pool.query<{
      id: string;
      key: string;
      name: string;
      description: string | null;
      created_at: Date;
    }>(
      `
        select id, key, name, description, created_at
        from projects
        order by created_at asc
      `,
    );

    return { projects: result.rows.map(mapProject) };
  });

  app.post("/api/projects", async (request, reply) => {
    const input = projectInputSchema.parse(request.body);
    const result = await db.pool.query<{
      id: string;
      key: string;
      name: string;
      description: string | null;
      created_at: Date;
    }>(
      `
        insert into projects (key, name, description)
        values ($1, $2, $3)
        returning id, key, name, description, created_at
      `,
      [input.key, input.name, input.description ?? null],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Project insert did not return a row");
    }

    return reply.code(201).send({ project: mapProject(row) });
  });

  app.get("/api/tasks", async (request) => {
    const query = z
      .object({
        projectId: z.string().uuid().optional(),
        status: z.string().optional(),
      })
      .parse(request.query);

    const values: string[] = [];
    const clauses: string[] = [];

    if (query.projectId) {
      values.push(query.projectId);
      clauses.push(`project_id = $${values.length}`);
    }

    if (query.status) {
      const status: TaskStatus = assertTaskStatus(query.status);
      values.push(status);
      clauses.push(`status = $${values.length}`);
    }

    const result = await db.pool.query<{
      id: string;
      project_id: string;
      title: string;
      instructions: string;
      status: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        select id, project_id, title, instructions, status, created_at, updated_at
        from tasks
        ${clauses.length > 0 ? `where ${clauses.join(" and ")}` : ""}
        order by created_at desc
        limit 100
      `,
      values,
    );

    return { tasks: result.rows.map(mapTask) };
  });

  app.post("/api/tasks", async (request, reply) => {
    const input = taskInputSchema.parse(request.body);
    const project = await db.pool.query("select id from projects where id = $1", [input.projectId]);
    if ((project.rowCount ?? 0) === 0) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const result = await db.pool.query<{
      id: string;
      project_id: string;
      title: string;
      instructions: string;
      status: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        insert into tasks (project_id, title, instructions, status)
        values ($1, $2, $3, 'created')
        returning id, project_id, title, instructions, status, created_at, updated_at
      `,
      [input.projectId, input.title, input.instructions],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Task insert did not return a row");
    }

    await appendEvent(db.pool, redis, {
      projectId: row.project_id,
      taskId: row.id,
      type: "task.created",
      payload: {
        title: row.title,
        status: row.status,
      },
    });

    return reply.code(201).send({ task: mapTask(row) });
  });

  app.get("/api/runtime/hermes", async (request, reply) => {
    const response = await fetch(`${config.hermesManagerUrl}/capabilities`);
    const body = (await response.json()) as HermesCapabilitySummary;
    if (!response.ok) {
      return reply.code(response.status).send(body);
    }

    return body;
  });

  app.all("/api/hermes/*", async (request, reply) => {
    const targetPath = hermesProxyPath(request.url);
    const response = await fetch(
      `${config.hermesManagerUrl}${targetPath}`,
      proxyRequestInit(request.method, request.body, request.headers),
    );
    const contentType = response.headers.get("content-type") || "";
    const sessionKey = response.headers.get("x-hermes-session-key");
    const sessionId = response.headers.get("x-hermes-session-id");

    if (contentType.includes("text/event-stream")) {
      reply.hijack();
      reply.raw.writeHead(response.status, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream",
        "referrer-policy": response.headers.get("referrer-policy") || "no-referrer",
        "x-accel-buffering": "no",
        "x-content-type-options": response.headers.get("x-content-type-options") || "nosniff",
        ...(sessionId ? { "x-hermes-session-id": sessionId } : {}),
        ...(sessionKey ? { "x-hermes-session-key": sessionKey } : {}),
      });
      if (!response.body) {
        reply.raw.end();
        return;
      }
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        reply.raw.write(Buffer.from(chunk));
      }
      reply.raw.end();
      return;
    }

    const text = await response.text();
    reply.code(response.status).header("content-type", contentType || "application/json");
    for (const name of ["referrer-policy", "x-content-type-options", "x-hermes-session-id", "x-hermes-session-key"]) {
      const value = response.headers.get(name);
      if (value) {
        reply.header(name, value);
      }
    }
    return text ? JSON.parse(text) : {};
  });

  app.get("/api/tasks/:taskId/runtime", async (request, reply) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params);

    const taskResult = await db.pool.query<{
      id: string;
      project_id: string;
      title: string;
      instructions: string;
      status: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        select id, project_id, title, instructions, status, created_at, updated_at
        from tasks
        where id = $1
      `,
      [params.taskId],
    );

    const taskRow = taskResult.rows[0];
    if (!taskRow) {
      return reply.code(404).send({ error: "Task not found" });
    }

    const [sessionsResult, runsResult, checkpointsResult, artifactsResult, eventsResult] =
      await Promise.all([
        db.pool.query<{
          id: string;
          task_id: string;
          runtime_profile_id: string | null;
          hermes_session_id: string | null;
          hermes_run_id: string | null;
          created_at: Date;
          updated_at: Date;
        }>(
          `
            select id, task_id, runtime_profile_id, hermes_session_id, hermes_run_id, created_at, updated_at
            from runtime_sessions
            where task_id = $1
            order by created_at desc
          `,
          [params.taskId],
        ),
        db.pool.query<{
          id: string;
          task_id: string;
          soul_id: string | null;
          runtime_session_id: string | null;
          status: AgentRunSummary["status"];
          branch_name: string | null;
          worktree_path: string | null;
          started_at: Date | null;
          completed_at: Date | null;
          created_at: Date;
          updated_at: Date;
        }>(
          `
            select id, task_id, soul_id, runtime_session_id, status, branch_name, worktree_path,
                   started_at, completed_at, created_at, updated_at
            from agent_runs
            where task_id = $1
            order by created_at desc
          `,
          [params.taskId],
        ),
        db.pool.query<{
          id: string;
          task_id: string;
          agent_run_id: string | null;
          summary: string;
          git_commit_sha: string | null;
          snapshot_uri: string | null;
          checksum: string | null;
          changed_files: unknown;
          test_result: Record<string, unknown>;
          created_at: Date;
        }>(
          `
            select id, task_id, agent_run_id, summary, git_commit_sha, snapshot_uri,
                   checksum, changed_files, test_result, created_at
            from checkpoints
            where task_id = $1
            order by created_at desc
          `,
          [params.taskId],
        ),
        db.pool.query<{
          id: string;
          project_id: string | null;
          task_id: string | null;
          kind: string;
          uri: string;
          checksum: string | null;
          metadata: Record<string, unknown>;
          created_at: Date;
        }>(
          `
            select id, project_id, task_id, kind, uri, checksum, metadata, created_at
            from artifacts
            where task_id = $1
            order by created_at desc
          `,
          [params.taskId],
        ),
        db.pool.query<{
          id: string;
          project_id: string | null;
          task_id: string | null;
          type: EventType;
          payload: Record<string, unknown>;
          created_at: Date;
        }>(
          `
            select id, project_id, task_id, type, payload, created_at
            from events
            where task_id = $1
            order by created_at desc
            limit 100
          `,
          [params.taskId],
        ),
      ]);

    const runtime: TaskRuntimeSummary = {
      task: mapTask(taskRow),
      sessions: sessionsResult.rows.map(mapSession),
      runs: runsResult.rows.map(mapRun),
      checkpoints: checkpointsResult.rows.map(mapCheckpoint),
      artifacts: artifactsResult.rows.map(mapArtifact),
      events: eventsResult.rows.map(mapEvent),
    };

    return runtime;
  });

  app.get("/events/stream", async (_request, reply) => {
    const subscriber = new Redis(config.redisUrl);
    await subscriber.subscribe(EVENT_CHANNEL);

    reply.hijack();
    reply.raw.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
    });

    const recent = await db.pool.query<{
      id: string;
      project_id: string | null;
      task_id: string | null;
      type: EventType;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `
        select id, project_id, task_id, type, payload, created_at
        from events
        order by created_at desc
        limit 50
      `,
    );

    for (const row of recent.rows.reverse()) {
      reply.raw.write(
        encodeSse(
          row.type,
          {
            id: row.id,
            projectId: row.project_id,
            taskId: row.task_id,
            type: row.type,
            payload: row.payload,
            createdAt: row.created_at.toISOString(),
          },
          row.id,
        ),
      );
    }

    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");
    }, 15_000);

    subscriber.on("message", (_channel, message) => {
      const parsed = JSON.parse(message) as { id: string; type: string };
      reply.raw.write(encodeSse(parsed.type, parsed, parsed.id));
    });

    reply.raw.on("close", () => {
      clearInterval(heartbeat);
      subscriber.disconnect();
    });
  });

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

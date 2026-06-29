import { TERMES_VERSION } from "@termes/shared";
import Fastify from "fastify";
import Redis from "ioredis";
import pg from "pg";

const EVENT_CHANNEL = "termes.events";

type HermesTerminalStatus = "completed" | "failed" | "cancelled";

interface ClaimedTask {
  id: string;
  projectId: string;
  title: string;
  instructions: string;
  soulId: string;
  runtimeSessionId: string;
  agentRunId: string;
  worktreePath: string;
}

interface HermesRunCreateResponse {
  run_id?: string;
  status?: string;
  session_id?: string;
}

interface HermesRunStatus {
  run_id?: string;
  status?: string;
  session_id?: string;
  model?: string;
  output?: string;
  usage?: Record<string, unknown>;
  artifact_uri?: string;
  checksum?: string;
  changed_files?: unknown[];
  worktree_path?: string;
  commands?: unknown[];
  events?: unknown[];
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function port(): number {
  const raw = process.env.PORT || "8080";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }

  return parsed;
}

function hermesManagerUrl(): string {
  return (process.env.HERMES_MANAGER_URL || "http://hermes-manager:8080").replace(/\/+$/, "");
}

function runTimeoutMs(): number {
  const raw = process.env.HERMES_RUN_TIMEOUT_MS || "120000";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 5_000) {
    throw new Error(`Invalid HERMES_RUN_TIMEOUT_MS: ${raw}`);
  }

  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function appendEvent(
  client: pg.PoolClient,
  redis: Redis,
  input: {
    projectId: string;
    taskId: string;
    type: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const result = await client.query<{
    id: string;
    project_id: string | null;
    task_id: string | null;
    type: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `
      insert into events (project_id, task_id, type, payload)
      values ($1, $2, $3, $4::jsonb)
      returning id, project_id, task_id, type, payload, created_at
    `,
    [input.projectId, input.taskId, input.type, JSON.stringify(input.payload)],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Event insert did not return a row");
  }

  await redis.publish(
    EVENT_CHANNEL,
    JSON.stringify({
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      type: row.type,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
    }),
  );
}

async function claimTask(pool: pg.Pool, redis: Redis): Promise<ClaimedTask | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const taskResult = await client.query<{
      id: string;
      project_id: string;
      title: string;
      instructions: string;
      status: string;
    }>(
      `
        select id, project_id, title, instructions, status
        from tasks
        where status = 'created'
           or (
             status = 'running'
             and updated_at < now() - interval '20 seconds'
             and not exists (
               select 1
               from runtime_sessions
               where runtime_sessions.task_id = tasks.id
                 and runtime_sessions.hermes_run_id is not null
             )
           )
        order by created_at asc
        for update skip locked
        limit 1
      `,
    );

    const task = taskResult.rows[0];
    if (!task) {
      await client.query("commit");
      return null;
    }

    if (task.status === "running") {
      await client.query(
        `
          update agent_runs
          set status = 'cancelled', completed_at = now(), updated_at = now()
          where task_id = $1 and status = 'running'
        `,
        [task.id],
      );
    }

    await client.query(
      `
        update tasks
        set status = 'running', updated_at = now()
        where id = $1
      `,
      [task.id],
    );

    const profileResult = await client.query<{ id: string }>(
      `
        insert into runtime_profiles (
          project_id,
          name,
          hermes_home,
          codex_home,
          codex_runtime_enabled
        )
        values ($1, 'default', $2, $3, false)
        on conflict (project_id, name) do update
        set hermes_home = excluded.hermes_home,
            codex_home = excluded.codex_home
        returning id
      `,
      [
        task.project_id,
        `/data/docker_data/termes/hermes/profiles/${task.project_id}/default`,
        `/data/docker_data/termes/hermes/codex-homes/${task.project_id}/default`,
      ],
    );

    const profile = profileResult.rows[0];
    if (!profile) {
      throw new Error("Runtime profile upsert did not return a row");
    }

    const soulResult = await client.query<{ id: string }>(
      `
        insert into agent_souls (
          project_id,
          role_name,
          mission,
          prompt,
          allowed_paths,
          denied_paths,
          allowed_commands,
          denied_commands
        )
        values (
          $1,
          'Architect',
          'Execute the task through Hermes and produce a checkpointed result.',
          $2,
          $3::jsonb,
          $4::jsonb,
          $5::jsonb,
          $6::jsonb
        )
        returning id
      `,
      [
        task.project_id,
        `Project task: ${task.title}\n\n${task.instructions}`,
        JSON.stringify(["/workspace", "/data/docker_data/termes/workspaces", "/data/docker_data/termes/runs"]),
        JSON.stringify(["/", "/etc", "/root", "/var/run/docker.sock"]),
        JSON.stringify(["rg", "sed", "node", "pnpm", "git status", "git diff", "git apply"]),
        JSON.stringify(["sudo", "su", "docker", "systemctl", "rm -rf /", "curl | sh", "wget | sh"]),
      ],
    );

    const soul = soulResult.rows[0];
    if (!soul) {
      throw new Error("Soul insert did not return a row");
    }

    const sessionResult = await client.query<{ id: string }>(
      `
        insert into runtime_sessions (
          task_id,
          runtime_profile_id,
          hermes_session_id
        )
        values ($1, $2, $3)
        returning id
      `,
      [task.id, profile.id, `termes-task-${task.id}`],
    );

    const session = sessionResult.rows[0];
    if (!session) {
      throw new Error("Runtime session insert did not return a row");
    }

    const worktreePath = `/data/docker_data/termes/runs/${task.id}/architect/worktree`;
    const runResult = await client.query<{ id: string }>(
      `
        insert into agent_runs (
          task_id,
          soul_id,
          runtime_session_id,
          status,
          branch_name,
          worktree_path,
          started_at
        )
        values ($1, $2, $3, 'running', $4, $5, now())
        returning id
      `,
      [task.id, soul.id, session.id, `task/${task.id}/architect`, worktreePath],
    );

    const run = runResult.rows[0];
    if (!run) {
      throw new Error("Agent run insert did not return a row");
    }

    await appendEvent(client, redis, {
      projectId: task.project_id,
      taskId: task.id,
      type: "task.started",
      payload: { title: task.title },
    });

    await appendEvent(client, redis, {
      projectId: task.project_id,
      taskId: task.id,
      type: "agent.created",
      payload: { agentRunId: run.id, role: "Architect", runtimeSessionId: session.id },
    });

    await appendEvent(client, redis, {
      projectId: task.project_id,
      taskId: task.id,
      type: "agent.started",
      payload: { agentRunId: run.id, role: "Architect", runtime: "hermes" },
    });

    await client.query("commit");

    return {
      id: task.id,
      projectId: task.project_id,
      title: task.title,
      instructions: task.instructions,
      soulId: soul.id,
      runtimeSessionId: session.id,
      agentRunId: run.id,
      worktreePath,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function createHermesRun(task: ClaimedTask): Promise<string> {
  const response = await fetch(`${hermesManagerUrl()}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: `termes-task-${task.id}`,
      profile: "default",
      input: task.instructions,
      instructions: [
        "You are the Termes Architect agent.",
        "Work only inside the allowed Termes workspace and runs roots.",
        `Task title: ${task.title}`,
        `Worktree path: ${task.worktreePath}`,
      ].join("\n"),
      metadata: {
        taskId: task.id,
        projectId: task.projectId,
        agentRunId: task.agentRunId,
        title: task.title,
        worktreePath: task.worktreePath,
      },
    }),
  });

  const body = (await response.json()) as HermesRunCreateResponse;
  if (!response.ok || !body.run_id) {
    throw new Error(`Hermes run creation failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body.run_id;
}

async function getHermesRun(runId: string): Promise<HermesRunStatus> {
  const response = await fetch(`${hermesManagerUrl()}/v1/runs/${encodeURIComponent(runId)}`);
  const body = (await response.json()) as HermesRunStatus;
  if (!response.ok) {
    throw new Error(`Hermes run status failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

async function waitForHermesRun(runId: string): Promise<HermesRunStatus> {
  const startedAt = Date.now();
  const timeout = runTimeoutMs();

  while (Date.now() - startedAt < timeout) {
    const run = await getHermesRun(runId);
    if (run.status === "waiting_approval") {
      return run;
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return run;
    }

    await sleep(750);
  }

  throw new Error(`Hermes run ${runId} timed out after ${timeout}ms`);
}

async function markRunId(pool: pg.Pool, redis: Redis, task: ClaimedTask, hermesRunId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `
        update runtime_sessions
        set hermes_run_id = $1, updated_at = now()
        where id = $2
      `,
      [hermesRunId, task.runtimeSessionId],
    );
    await appendEvent(client, redis, {
      projectId: task.projectId,
      taskId: task.id,
      type: "agent.delta",
      payload: { agentRunId: task.agentRunId, hermesRunId, text: "Hermes run started." },
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function completeTask(
  pool: pg.Pool,
  redis: Redis,
  task: ClaimedTask,
  hermesRunId: string,
  run: HermesRunStatus,
): Promise<void> {
  const status = run.status as HermesTerminalStatus | "waiting_approval" | undefined;
  const client = await pool.connect();
  try {
    await client.query("begin");

    if (status === "waiting_approval") {
      const approvalResult = await client.query<{ id: string }>(
        `
          insert into approvals (task_id, agent_run_id, type, summary, payload)
          values ($1, $2, 'hermes.run', $3, $4::jsonb)
          returning id
        `,
        [
          task.id,
          task.agentRunId,
          `Hermes run ${hermesRunId} is waiting for approval.`,
          JSON.stringify({ hermesRunId, status: run.status }),
        ],
      );

      await client.query(
        `
          update tasks set status = 'reviewing', updated_at = now() where id = $1
        `,
        [task.id],
      );
      await client.query(
        `
          update agent_runs set status = 'waiting_approval', updated_at = now() where id = $1
        `,
        [task.agentRunId],
      );
      await appendEvent(client, redis, {
        projectId: task.projectId,
        taskId: task.id,
        type: "approval.requested",
        payload: { approvalId: approvalResult.rows[0]?.id, hermesRunId },
      });
      await client.query("commit");
      return;
    }

    if (status !== "completed") {
      await client.query(
        `
          update tasks set status = $2, updated_at = now() where id = $1
        `,
        [task.id, status === "cancelled" ? "cancelled" : "failed"],
      );
      await client.query(
        `
          update agent_runs
          set status = $2, completed_at = now(), updated_at = now()
          where id = $1
        `,
        [task.agentRunId, status === "cancelled" ? "cancelled" : "failed"],
      );
      await appendEvent(client, redis, {
        projectId: task.projectId,
        taskId: task.id,
        type: "task.failed",
        payload: { agentRunId: task.agentRunId, hermesRunId, status: status || "failed" },
      });
      await client.query("commit");
      return;
    }

    const output = run.output || `Hermes run ${hermesRunId} completed.`;
    const artifactUri = run.artifact_uri || `hermes://runs/${hermesRunId}`;
    const changedFiles = Array.isArray(run.changed_files) ? run.changed_files : [];
    const checkpointResult = await client.query<{ id: string }>(
      `
        insert into checkpoints (
          task_id,
          agent_run_id,
          summary,
          snapshot_uri,
          checksum,
          changed_files,
          test_result
        )
        values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
        returning id
      `,
      [
        task.id,
        task.agentRunId,
        output.slice(0, 900),
        artifactUri,
        run.checksum || null,
        JSON.stringify(changedFiles),
        JSON.stringify({
          hermesRunId,
          status: run.status,
          usage: run.usage || {},
          worktreePath: run.worktree_path || task.worktreePath,
          commands: run.commands || [],
        }),
      ],
    );

    await client.query(
      `
        insert into artifacts (project_id, task_id, kind, uri, checksum, metadata)
        values ($1, $2, 'hermes.run.output', $3, $4, $5::jsonb)
      `,
      [
        task.projectId,
        task.id,
        artifactUri,
        run.checksum || null,
        JSON.stringify({
          hermesRunId,
          model: run.model || null,
          output,
          worktreePath: run.worktree_path || task.worktreePath,
          changedFiles,
          commands: run.commands || [],
          events: run.events || [],
        }),
      ],
    );

    await client.query(
      `
        update agent_runs
        set status = 'completed', completed_at = now(), updated_at = now()
        where id = $1
      `,
      [task.agentRunId],
    );
    await client.query(
      `
        update tasks
        set status = 'completed', updated_at = now()
        where id = $1
      `,
      [task.id],
    );

    await appendEvent(client, redis, {
      projectId: task.projectId,
      taskId: task.id,
      type: "checkpoint.created",
      payload: {
        checkpointId: checkpointResult.rows[0]?.id,
        agentRunId: task.agentRunId,
        hermesRunId,
        artifactUri,
      },
    });
    await appendEvent(client, redis, {
      projectId: task.projectId,
      taskId: task.id,
      type: "task.completed",
      payload: { agentRunId: task.agentRunId, hermesRunId, summary: output.slice(0, 240) },
    });

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function failTask(pool: pg.Pool, redis: Redis, task: ClaimedTask, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `
        update tasks set status = 'failed', updated_at = now() where id = $1
      `,
      [task.id],
    );
    await client.query(
      `
        update agent_runs
        set status = 'failed', completed_at = now(), updated_at = now()
        where id = $1
      `,
      [task.agentRunId],
    );
    await appendEvent(client, redis, {
      projectId: task.projectId,
      taskId: task.id,
      type: "task.failed",
      payload: { agentRunId: task.agentRunId, message },
    });
    await client.query("commit");
  } catch (nestedError) {
    await client.query("rollback");
    throw nestedError;
  } finally {
    client.release();
  }
}

async function runOneCycle(pool: pg.Pool, redis: Redis): Promise<boolean> {
  const task = await claimTask(pool, redis);
  if (!task) {
    return false;
  }

  try {
    const hermesRunId = await createHermesRun(task);
    await markRunId(pool, redis, task, hermesRunId);
    const run = await waitForHermesRun(hermesRunId);
    await completeTask(pool, redis, task, hermesRunId, run);
  } catch (error) {
    await failTask(pool, redis, task, error);
    throw error;
  }

  return true;
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: requiredEnv("DATABASE_URL") });
  const redis = new Redis(requiredEnv("REDIS_URL"), {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  });
  await redis.connect();

  const app = Fastify({ logger: true });
  let processedTasks = 0;
  let processing = false;

  app.get("/healthz", async () => {
    await pool.query("select 1");
    await redis.ping();

    return {
      service: "orchestrator",
      version: TERMES_VERSION,
      status: "ok",
      processedTasks,
      hermesManagerUrl: hermesManagerUrl(),
      checkedAt: new Date().toISOString(),
    };
  });

  app.addHook("onClose", async () => {
    redis.disconnect();
    await pool.end();
  });

  setInterval(() => {
    if (processing) {
      return;
    }

    processing = true;
    runOneCycle(pool, redis)
      .then((processed) => {
        if (processed) {
          processedTasks += 1;
        }
      })
      .catch((error: unknown) => {
        app.log.error(error);
      })
      .finally(() => {
        processing = false;
      });
  }, 3_000);

  await app.listen({ host: "0.0.0.0", port: port() });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

import { TERMES_VERSION } from "@termes/shared";
import {
  EventOutboxDispatcher,
  TERMES_TURN_STREAM,
  appendTransactionalEvent,
} from "@termes/eventing";
import Fastify from "fastify";
import Redis from "ioredis";
import { createHash } from "node:crypto";
import pg from "pg";
import {
  buildSpecialistBlueprint,
  coordinatorInstructions,
  type SpecialistBlueprint,
} from "./specialist-blueprint";
import {
  ROUTING_POLICY_VERSION,
  type RouteDecision,
  type RoutingScreeningDecision,
  type RoutingSystemContext,
} from "./routing-policy";
import { executeHermesJsonRpcRun } from "./hermes-json-rpc-runner";
import { HermesRoutingSpecialist } from "./routing-specialist";
import { dashboardWorkspacePath } from "./workspace-path";

type HermesTerminalStatus = "completed" | "failed" | "cancelled";

interface ClaimedTask {
  id: string;
  accountId: string;
  workspaceId: string;
  runtimeCellId: string;
  projectId: string;
  title: string;
  instructions: string;
  soulId: string;
  runtimeSessionId: string;
  agentRunId: string;
  worktreePath: string;
  workspacePath: string;
  conversationContext: string;
  turnId: string | null;
  routeDecision: RouteDecision;
  resumeStoredSessionId: string | null;
  blueprintId: string;
  blueprint: SpecialistBlueprint;
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

interface PlanStep {
  id: string;
  type: "hermes.run" | "runner.run" | "device.command" | "approval.required" | "verification.check";
  title: string;
  status: "created" | "running" | "completed" | "failed" | "blocked";
  capabilityKey: string | null;
  deviceCommandId: string | null;
  verificationResultId: string | null;
  order: number;
}

type RoutingResult = {
  decision: RouteDecision;
  durationMs: number;
  hash: string;
  routingSessionId: string | null;
};

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

function hermesManagerServiceToken(): string {
  return requiredEnv("HERMES_MANAGER_SERVICE_TOKEN");
}

function apiBaseUrl(): string {
  return (process.env.API_BASE_URL || "http://api:8080").replace(/\/+$/, "");
}

function runTimeoutMs(): number {
  const raw = process.env.HERMES_RUN_TIMEOUT_MS || "120000";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 5_000) {
    throw new Error(`Invalid HERMES_RUN_TIMEOUT_MS: ${raw}`);
  }

  return parsed;
}

async function appendEvent(
  client: Pick<pg.Pool, "query">,
  redis: Redis,
  input: {
    projectId: string;
    taskId: string;
    type: string;
    payload: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  void redis;
  return appendTransactionalEvent(client as pg.Pool | pg.PoolClient, input);
}

function buildTaskPlanSteps(selectedCapabilities: string[]): PlanStep[] {
  const deviceCapabilities = new Set([
    "linux-ssh-ops",
    "windows-powershell-ops",
    "android-adb-debug",
    "tizen-sdb-debug",
    "local-mock-device",
  ]);
  const steps: PlanStep[] = [
    {
      id: "step-1",
      type: "hermes.run",
      title: "Analyze task intent and runtime context",
      status: "created",
      capabilityKey: null,
      deviceCommandId: null,
      verificationResultId: null,
      order: 1,
    },
  ];
  let order = 2;
  for (const capabilityKey of selectedCapabilities) {
    const isDeviceCapability = deviceCapabilities.has(capabilityKey);
    steps.push({
      id: `step-${order}`,
      type: isDeviceCapability ? "device.command" : "runner.run",
      title: `Execute ${capabilityKey}`,
      status: "created",
      capabilityKey,
      deviceCommandId: null,
      verificationResultId: null,
      order,
    });
    order += 1;
  }
  steps.push({
    id: `step-${order}`,
    type: "verification.check",
    title: "Verify artifacts, events, and command results",
    status: "created",
    capabilityKey: "runner-worktree-verification",
    deviceCommandId: null,
    verificationResultId: null,
    order,
  });
  return steps;
}

async function ensureTaskPlan(
  client: pg.PoolClient,
  redis: Redis,
  task: { id: string; projectId: string; title: string; instructions: string },
  selectedCapabilities: string[],
): Promise<PlanStep[]> {
  const existing = await client.query<{ steps: unknown }>("select steps from task_plans where task_id = $1", [task.id]);
  const existingSteps = existing.rows[0]?.steps;
  if (Array.isArray(existingSteps)) {
    return existingSteps as PlanStep[];
  }

  const steps = buildTaskPlanSteps(selectedCapabilities);
  const insertResult = await client.query<{ id: string }>(
    `
      insert into task_plans (task_id, selected_capabilities, steps, status)
      values ($1, $2::jsonb, $3::jsonb, 'created')
      on conflict (task_id) do nothing
      returning id
    `,
    [task.id, JSON.stringify(selectedCapabilities), JSON.stringify(steps)],
  );
  if (insertResult.rowCount && insertResult.rowCount > 0) {
    await appendEvent(client, redis, {
      projectId: task.projectId,
      taskId: task.id,
      type: "task.plan.created",
      payload: { selectedCapabilities, stepCount: steps.length },
    });
    return steps;
  }

  const current = await client.query<{ steps: unknown }>("select steps from task_plans where task_id = $1", [task.id]);
  const currentSteps = current.rows[0]?.steps;
  if (Array.isArray(currentSteps)) {
    return currentSteps as PlanStep[];
  }
  return steps;
}

async function updateTaskPlan(
  client: pg.PoolClient,
  redis: Redis,
  task: { id: string; projectId: string },
  update: (steps: PlanStep[]) => PlanStep[],
  eventType: string,
  summary: Record<string, unknown>,
): Promise<void> {
  const result = await client.query<{ steps: unknown }>("select steps from task_plans where task_id = $1", [task.id]);
  const currentSteps = Array.isArray(result.rows[0]?.steps) ? (result.rows[0]?.steps as PlanStep[]) : [];
  if (currentSteps.length === 0) {
    return;
  }
  const steps = update(currentSteps);
  const status = steps.some((step) => step.status === "failed")
    ? "failed"
    : steps.some((step) => step.status === "blocked")
      ? "blocked"
      : steps.every((step) => step.status === "completed")
        ? "completed"
        : steps.some((step) => step.status === "running")
          ? "running"
          : "created";
  await client.query(
    `
      update task_plans
      set steps = $2::jsonb, status = $3, updated_at = now()
      where task_id = $1
    `,
    [task.id, JSON.stringify(steps), status],
  );
  await appendEvent(client, redis, {
    projectId: task.projectId,
    taskId: task.id,
    type: eventType,
    payload: { ...summary, status },
  });
}

function devicePlanContract(capabilityKey: string | null): { platform: string; action: string; params: Record<string, unknown> } | null {
  if (capabilityKey === "local-mock-device") {
    return {
      platform: "local_mock",
      action: "local_mock.echo",
      params: { payload: "orchestrator device command" },
    };
  }
  if (capabilityKey === "windows-powershell-ops") {
    return { platform: "windows", action: "windows.system.info", params: {} };
  }
  if (capabilityKey === "linux-ssh-ops") {
    return { platform: "linux", action: "linux.system.info", params: {} };
  }
  if (capabilityKey === "android-adb-debug") {
    return { platform: "android", action: "android.system.info", params: {} };
  }
  if (capabilityKey === "tizen-sdb-debug") {
    return { platform: "tizen", action: "tizen.system.info", params: {} };
  }
  return null;
}

async function executeDevicePlanSteps(client: pg.PoolClient, redis: Redis, task: ClaimedTask): Promise<void> {
  const planResult = await client.query<{ steps: unknown }>("select steps from task_plans where task_id = $1", [task.id]);
  let steps = Array.isArray(planResult.rows[0]?.steps) ? (planResult.rows[0]?.steps as PlanStep[]) : [];
  if (!steps.some((step) => step.type === "device.command")) {
    return;
  }

  for (const step of steps.filter((entry) => entry.type === "device.command")) {
    if (step.status === "completed" || step.status === "failed" || step.status === "blocked") {
      continue;
    }

    const contract = devicePlanContract(step.capabilityKey);
    if (!contract) {
      steps = steps.map((entry) => (entry.id === step.id ? { ...entry, status: "blocked" } : entry));
      await client.query("update task_plans set steps = $2::jsonb, status = 'blocked', updated_at = now() where task_id = $1", [
        task.id,
        JSON.stringify(steps),
      ]);
      await appendEvent(client, redis, {
        projectId: task.projectId,
        taskId: task.id,
        type: "task.plan.step.failed",
        payload: { stepId: step.id, capabilityKey: step.capabilityKey, reason: "No device command contract" },
      });
      continue;
    }

    const deviceResult = await client.query<{ id: string }>(
      `
        select id
        from devices
        where project_id = $1 and platform = $2
        order by case status when 'online' then 0 when 'busy' then 1 when 'unknown' then 2 else 3 end, updated_at desc
        limit 1
      `,
      [task.projectId, contract.platform],
    );
    const deviceId = deviceResult.rows[0]?.id;
    if (!deviceId) {
      const verificationResult = await client.query<{ id: string }>(
        `
          insert into verification_results (project_id, task_id, kind, status, confidence, summary, metadata)
          values ($1, $2, 'device.command', 'warning', 0.7, $3, $4::jsonb)
          returning id
        `,
        [
          task.projectId,
          task.id,
          `${step.capabilityKey || "device"} device is not registered.`,
          JSON.stringify({ stepId: step.id, capabilityKey: step.capabilityKey, platform: contract.platform }),
        ],
      );
      const verificationResultId = verificationResult.rows[0]?.id || null;
      steps = steps.map((entry) =>
        entry.id === step.id ? { ...entry, status: "blocked", verificationResultId } : entry,
      );
      await client.query("update task_plans set steps = $2::jsonb, status = 'blocked', updated_at = now() where task_id = $1", [
        task.id,
        JSON.stringify(steps),
      ]);
      await appendEvent(client, redis, {
        projectId: task.projectId,
        taskId: task.id,
        type: "verification.created",
        payload: { verificationResultId, kind: "device.command", status: "warning" },
      });
      await appendEvent(client, redis, {
        projectId: task.projectId,
        taskId: task.id,
        type: "task.plan.step.failed",
        payload: { stepId: step.id, capabilityKey: step.capabilityKey, reason: "Device is not registered" },
      });
      continue;
    }

    steps = steps.map((entry) => (entry.id === step.id ? { ...entry, status: "running" } : entry));
    await client.query("update task_plans set steps = $2::jsonb, status = 'running', updated_at = now() where task_id = $1", [
      task.id,
      JSON.stringify(steps),
    ]);
    await appendEvent(client, redis, {
      projectId: task.projectId,
      taskId: task.id,
      type: "task.plan.step.started",
      payload: { stepId: step.id, capabilityKey: step.capabilityKey, action: contract.action },
    });

    const response = await fetch(`${apiBaseUrl()}/api/devices/${encodeURIComponent(deviceId)}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${hermesManagerServiceToken()}`,
        "x-termes-account-id": task.accountId,
        "x-termes-workspace-id": task.workspaceId,
        "x-termes-runtime-cell-id": task.runtimeCellId,
      },
      body: JSON.stringify({
        taskId: task.id,
        action: contract.action,
        params: contract.params,
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      command?: { id?: string; status?: string };
      verificationResult?: { id?: string };
      error?: string;
    } | null;
    const commandStatus = body?.command?.status || "failed";
    const stepStatus: PlanStep["status"] =
      response.ok && commandStatus === "completed" ? "completed" : commandStatus === "blocked" ? "blocked" : "failed";
    steps = steps.map((entry) =>
      entry.id === step.id
        ? {
            ...entry,
            status: stepStatus,
            deviceCommandId: body?.command?.id || null,
            verificationResultId: body?.verificationResult?.id || null,
          }
        : entry,
    );
    await client.query("update task_plans set steps = $2::jsonb, updated_at = now() where task_id = $1", [
      task.id,
      JSON.stringify(steps),
    ]);
    await appendEvent(client, redis, {
      projectId: task.projectId,
      taskId: task.id,
      type: stepStatus === "completed" ? "task.plan.step.completed" : "task.plan.step.failed",
      payload: {
        stepId: step.id,
        capabilityKey: step.capabilityKey,
        action: contract.action,
        deviceCommandId: body?.command?.id || null,
        verificationResultId: body?.verificationResult?.id || null,
        status: stepStatus,
        error: body?.error || null,
      },
    });
  }
}

async function previewTask(pool: pg.Pool, runtimeCellId: string): Promise<{
  id: string;
  turnId: string | null;
  instructions: string;
  conversationContext: string;
  accountId: string;
  workspaceId: string;
  workspaceKey: string;
  projectId: string;
  projectName: string;
  projectKey: string;
  workspaceHostPath: string;
} | null> {
  const result = await pool.query<{
    id: string;
    turn_id: string | null;
    instructions: string;
    account_id: string;
    workspace_id: string;
    workspace_key: string;
    project_id: string;
    project_name: string;
    project_key: string;
    workspace_host_path: string;
  }>(
    `
      select t.id, pending_turn.id as turn_id, t.instructions, t.account_id, t.workspace_id, aw.key as workspace_key,
             t.project_id, p.name as project_name, p.key as project_key,
             wr.host_path as workspace_host_path
      from tasks t
      join runtime_cells rc on rc.account_id = t.account_id and rc.workspace_id = t.workspace_id and rc.status = 'active'
      join account_workspaces aw on aw.id = t.workspace_id and aw.account_id = t.account_id and aw.status = 'active'
      join projects p on p.id = t.project_id and p.workspace_id = t.workspace_id
      join lateral (
        select host_path from workspace_roots
        where project_id = t.project_id
        order by created_at asc
        limit 1
      ) wr on true
      left join lateral (
        select id from task_turns
        where task_id = t.id and status = 'requested'
        order by created_at asc
        limit 1
      ) pending_turn on true
      where rc.id = $1 and t.status = 'created'
      order by t.created_at asc
      limit 1
    `,
    [runtimeCellId],
  );
  const task = result.rows[0];
  if (!task) return null;
  const messages = await pool.query<{ role: string; content: string }>(
    `
      select role, content from (
        select role, content, created_at from chat_messages
        where task_id = $1 and role in ('user', 'assistant')
        order by created_at desc limit 6
      ) recent order by created_at asc
    `,
    [task.id],
  );
  return {
    id: task.id,
    turnId: task.turn_id,
    instructions: task.instructions,
    accountId: task.account_id,
    workspaceId: task.workspace_id,
    workspaceKey: task.workspace_key,
    projectId: task.project_id,
    projectName: task.project_name,
    projectKey: task.project_key,
    workspaceHostPath: task.workspace_host_path,
    conversationContext: messages.rows.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n").slice(-4_000),
  };
}

function routingSystemContext(preview: NonNullable<Awaited<ReturnType<typeof previewTask>>>): RoutingSystemContext {
  return {
    projectId: preview.projectId,
    projectName: preview.projectName,
    projectKey: preview.projectKey,
    projectPath: dashboardWorkspacePath(preview.workspaceHostPath, preview.accountId),
    workspaceId: preview.workspaceId,
    workspaceKey: preview.workspaceKey,
  };
}

async function recordRoutingScreening(
  pool: pg.Pool,
  redis: Redis,
  preview: NonNullable<Awaited<ReturnType<typeof previewTask>>>,
  screening: RoutingScreeningDecision,
  durationMs: number,
  attempt: number,
): Promise<void> {
  await appendEvent(pool, redis, {
    projectId: preview.projectId,
    taskId: preview.id,
    type: "routing.screened",
    payload: {
      turnId: preview.turnId,
      attempt,
      questionType: screening.questionType,
      contextType: screening.contextType,
      domain: screening.domain,
      professionalRequired: screening.professionalRequired,
      hasDirectAnswer: screening.answer !== null,
      durationMs,
    },
  });
}

async function persistRoutingSession(
  pool: pg.Pool,
  scope: { accountId: string; workspaceId: string; runtimeCellId: string },
  router: HermesRoutingSpecialist,
): Promise<string> {
  const identity = router.identity;
  const result = await pool.query<{ id: string }>(
    `
      insert into routing_sessions (
        account_id, workspace_id, runtime_cell_id, policy_version,
        hermes_stored_session_id, hermes_live_session_id, status, last_ready_at, last_used_at
      ) values ($1, $2, $3, ${ROUTING_POLICY_VERSION}, $4, $5, 'ready', now(), now())
      on conflict (runtime_cell_id, policy_version) do update
      set hermes_stored_session_id = excluded.hermes_stored_session_id,
          hermes_live_session_id = excluded.hermes_live_session_id,
          status = 'ready', last_ready_at = now(), last_used_at = now(), updated_at = now()
      returning id
    `,
    [scope.accountId, scope.workspaceId, scope.runtimeCellId, identity.storedSessionId, identity.runtimeSessionId],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Routing session upsert did not return a row");
  return id;
}

function routingErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/i.test(message)) return "timeout";
  if (/session not found/i.test(message)) return "session_not_found";
  if (/Routing Agent|Planner Agent|invalid|no JSON object/i.test(message)) return "invalid_output";
  if (/closed|not connected|socket|connect/i.test(message)) return "transport";
  return "routing_error";
}

function routingErrorIsRetryable(error: unknown): boolean {
  const code = routingErrorCode(error);
  return code === "session_not_found" || code === "transport" || code === "invalid_output";
}

async function startRoutingAttempt(
  pool: pg.Pool,
  turnId: string | null,
  attempt: number,
): Promise<void> {
  if (!turnId) return;
  await pool.query(
    `
      insert into routing_attempts (turn_id, attempt, status)
      values ($1, $2, 'running')
      on conflict (turn_id, attempt) do update
      set routing_session_id = null,
          status = 'running', duration_ms = null, error_code = null,
          output_hash = null, completed_at = null
    `,
    [turnId, attempt],
  );
}

async function finishRoutingAttempt(
  pool: pg.Pool,
  input: {
    turnId: string | null;
    attempt: number;
    routingSessionId: string | null;
    status: "valid" | "invalid" | "failed";
    durationMs: number;
    errorCode?: string | null;
    outputHash?: string | null;
  },
): Promise<void> {
  if (!input.turnId) return;
  await pool.query(
    `
      update routing_attempts
      set routing_session_id = $3,
          status = $4,
          duration_ms = $5,
          error_code = $6,
          output_hash = $7,
          completed_at = now()
      where turn_id = $1 and attempt = $2
    `,
    [
      input.turnId,
      input.attempt,
      input.routingSessionId,
      input.status,
      input.durationMs,
      input.errorCode ?? null,
      input.outputHash ?? null,
    ],
  );
}

async function failRouting(
  pool: pg.Pool,
  redis: Redis,
  taskId: string,
  message: string,
  failureCode = "routing_failed",
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const task = await client.query<{ project_id: string; turn_id: string | null }>(
      `
        select t.project_id,
               (select id from task_turns where task_id = t.id and status = 'requested' order by created_at asc limit 1) as turn_id
        from tasks t where t.id = $1 for update
      `,
      [taskId],
    );
    const row = task.rows[0];
    if (!row) {
      await client.query("commit");
      return;
    }
    await client.query("update tasks set status = 'failed', updated_at = now() where id = $1 and status = 'created'", [taskId]);
    if (row.turn_id) {
      await client.query(
        "update task_turns set status = 'failed', failure_code = $2, failure_message = $3, completed_at = now() where id = $1",
        [row.turn_id, failureCode, message.slice(0, 2000)],
      );
      await appendEvent(client, redis, {
        projectId: row.project_id,
        taskId,
        type: "routing.failed",
        payload: { turnId: row.turn_id, failureCode, message: message.slice(0, 500) },
      });
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function claimTask(
  pool: pg.Pool,
  redis: Redis,
  runtimeCellId: string,
  expectedTaskId: string,
  routing: RoutingResult,
): Promise<ClaimedTask | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const taskResult = await client.query<{
      id: string;
      account_id: string;
      workspace_id: string;
      runtime_cell_id: string;
      hermes_home: string;
      project_id: string;
      title: string;
      instructions: string;
      status: string;
      workspace_path: string;
      turn_id: string | null;
    }>(
      `
        select t.id, t.account_id, t.workspace_id, rc.id as runtime_cell_id, rc.hermes_home,
               t.project_id, t.title, t.instructions, t.status, wr.host_path as workspace_path,
               pending_turn.id as turn_id
        from tasks t
        join runtime_cells rc
          on rc.account_id = t.account_id and rc.workspace_id = t.workspace_id and rc.status = 'active'
        join lateral (
          select host_path
          from workspace_roots
          where project_id = t.project_id
          order by created_at asc
          limit 1
        ) wr on true
        left join lateral (
          select id
          from task_turns
          where task_id = t.id and status = 'requested'
          order by created_at asc
          limit 1
        ) pending_turn on true
        where rc.id = $1 and t.id = $2
          and (t.status = 'created'
           or (
             t.status = 'running'
             and t.updated_at < now() - interval '20 seconds'
             and not exists (
               select 1
               from runtime_sessions
               where runtime_sessions.task_id = t.id
                 and runtime_sessions.hermes_run_id is not null
             )
           ))
        order by t.created_at asc
        for update of t skip locked
        limit 1
      `,
      [runtimeCellId, expectedTaskId],
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

    const routeDecision = routing.decision;
    const blueprint = buildSpecialistBlueprint(routeDecision);
    const workspacePath = dashboardWorkspacePath(task.workspace_path, task.account_id);
    const conversationResult = await client.query<{ role: string; content: string }>(
      `
        select role, content
        from (
          select role, content, created_at
          from chat_messages
          where task_id = $1 and role in ('user', 'assistant')
          order by created_at desc
          limit 20
        ) recent
        order by created_at asc
      `,
      [task.id],
    );
    const conversationContext = conversationResult.rows
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n\n")
      .slice(-30_000);

    await client.query(
      `
        update tasks
        set status = 'running', updated_at = now()
        where id = $1
      `,
      [task.id],
    );

    if (task.turn_id) {
      await client.query(
        "update task_turns set status = 'routing' where id = $1 and status = 'requested'",
        [task.turn_id],
      );
      const canonicalDecision = JSON.stringify(routeDecision);
      await client.query(
        `
          insert into route_decisions (
            turn_id, policy_version, source, intent, route, primary_domain,
            secondary_domains, risk_signals, evidence_requirement, context_requirement,
            reason_codes, semantic_frame, routing_duration_ms, decision_hash
          ) values ($1, ${ROUTING_POLICY_VERSION}, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb, $11::jsonb, $12, $13)
          on conflict (turn_id) do nothing
        `,
        [
          task.turn_id,
          routeDecision.source,
          routeDecision.intent,
          routeDecision.route,
          routeDecision.primaryDomain,
          JSON.stringify(routeDecision.secondaryDomains),
          JSON.stringify(routeDecision.riskSignals),
          routeDecision.evidenceRequirement,
          routeDecision.contextRequirement,
          JSON.stringify(routeDecision.reasonCodes),
          JSON.stringify(routeDecision.semanticFrame),
          routing.durationMs,
          routing.hash || createHash("sha256").update(canonicalDecision).digest("hex"),
        ],
      );
      if (routing.routingSessionId) {
        await client.query("update route_decisions set routing_session_id = $2 where turn_id = $1", [task.turn_id, routing.routingSessionId]);
      }
      await client.query(
        "update task_turns set status = 'running', routed_at = now(), started_at = now() where id = $1",
        [task.turn_id],
      );
      await appendEvent(client, redis, {
        projectId: task.project_id,
        taskId: task.id,
        type: "routing.decided",
        payload: {
          turnId: task.turn_id,
          route: routeDecision.route,
          intent: routeDecision.intent,
          domain: routeDecision.primaryDomain,
          action: routeDecision.semanticFrame.action,
          target: routeDecision.semanticFrame.target,
          requiresMutation: routeDecision.semanticFrame.requiresMutation,
          requiresInspection: routeDecision.semanticFrame.requiresInspection,
        },
      });
    }

    const profileResult = await client.query<{ id: string }>(
      `
        insert into runtime_profiles (
          account_id,
          workspace_id,
          runtime_cell_id,
          project_id,
          name,
          hermes_home,
          codex_home,
          codex_runtime_enabled
        )
        values ($1, $2, $3, $4, 'default', $5, $6, true)
        on conflict (project_id, name) do update
        set hermes_home = excluded.hermes_home,
            codex_home = excluded.codex_home,
            codex_runtime_enabled = true
        returning id
      `,
      [
        task.account_id,
        task.workspace_id,
        task.runtime_cell_id,
        task.project_id,
        task.hermes_home,
        "/data/docker_data/termes/hermes-agent/.codex",
      ],
    );

    const profile = profileResult.rows[0];
    if (!profile) {
      throw new Error("Runtime profile upsert did not return a row");
    }

    const reusableSession = blueprint.specialists.length === 0
      ? await client.query<{ hermes_session_id: string }>(
          `
            select hermes_session_id
            from runtime_sessions
            where task_id = $1 and hermes_session_id is not null and hermes_run_id is not null
            order by updated_at desc
            limit 1
          `,
          [task.id],
        )
      : { rows: [] as Array<{ hermes_session_id: string }> };
    const resumeStoredSessionId = reusableSession.rows[0]?.hermes_session_id || null;

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
          'Coordinator',
          'Classify, delegate, reconcile, verify, and produce the final Termes response through Hermes.',
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
        `${coordinatorInstructions(blueprint)}\n\nProject task: ${task.title}\n\n${task.instructions}`,
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
          account_id,
          workspace_id,
          runtime_cell_id,
          task_id,
          turn_id,
          runtime_profile_id,
          hermes_session_id
        )
        values ($1, $2, $3, $4, $5, $6, $7)
        returning id
      `,
      [task.account_id, task.workspace_id, task.runtime_cell_id, task.id, task.turn_id, profile.id, `termes-task-${task.id}`],
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

    const blueprintResult = await client.query<{ id: string }>(
      `
        insert into orchestration_blueprints (
          task_id,
          turn_id,
          version,
          domain,
          secondary_domains,
          weight,
          risk_signals,
          collaboration,
          require_evidence,
          require_independent_review,
          status
        )
        values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, 'planned')
        on conflict (turn_id) do update
        set version = excluded.version,
            domain = excluded.domain,
            secondary_domains = excluded.secondary_domains,
            weight = excluded.weight,
            risk_signals = excluded.risk_signals,
            collaboration = excluded.collaboration,
            require_evidence = excluded.require_evidence,
            require_independent_review = excluded.require_independent_review,
            status = 'planned',
            updated_at = now()
        returning id
      `,
      [
        task.id,
        task.turn_id,
        blueprint.version,
        blueprint.domain,
        JSON.stringify(blueprint.secondaryDomains),
        blueprint.weight,
        JSON.stringify(blueprint.riskSignals),
        blueprint.collaboration,
        blueprint.requireEvidence,
        blueprint.requireIndependentReview,
      ],
    );
    const blueprintId = blueprintResult.rows[0]?.id;
    if (!blueprintId) {
      throw new Error("Orchestration blueprint upsert did not return a row");
    }
    await client.query("delete from specialist_assignments where blueprint_id = $1", [blueprintId]);
    for (const specialist of blueprint.specialists) {
      await client.query(
        `
          insert into specialist_assignments (
            blueprint_id, assignment_key, role_name, mission, toolsets, required, status
          )
          values ($1, $2, $3, $4, $5::jsonb, $6, 'planned')
        `,
        [
          blueprintId,
          specialist.id,
          specialist.role,
          specialist.mission,
          JSON.stringify(specialist.toolsets),
          specialist.required,
        ],
      );
    }

    await appendEvent(client, redis, {
      projectId: task.project_id,
      taskId: task.id,
      type: "task.started",
      payload: { title: task.title },
    });

    if (blueprint.specialists.length > 0) {
      await ensureTaskPlan(client, redis, {
        id: task.id,
        projectId: task.project_id,
        title: task.title,
        instructions: task.instructions,
      }, routeDecision.selectedCapabilities);
      await updateTaskPlan(
        client,
        redis,
        { id: task.id, projectId: task.project_id },
        (steps) =>
          steps.map((step) =>
            step.order === 1
              ? {
                  ...step,
                  status: "running",
                }
              : step,
          ),
        "task.plan.step.started",
        { stepId: "step-1", title: "Analyze task intent and runtime context" },
      );
    }

    await appendEvent(client, redis, {
      projectId: task.project_id,
      taskId: task.id,
      type: "agent.created",
      payload: {
        agentRunId: run.id,
        role: "Coordinator",
        runtimeSessionId: session.id,
        blueprintId,
        classification: {
          domain: blueprint.domain,
          secondaryDomains: blueprint.secondaryDomains,
          weight: blueprint.weight,
          riskSignals: blueprint.riskSignals,
        },
        specialists: blueprint.specialists.map((specialist) => ({
          id: specialist.id,
          role: specialist.role,
          toolsets: specialist.toolsets,
        })),
      },
    });

    await appendEvent(client, redis, {
      projectId: task.project_id,
      taskId: task.id,
      type: "agent.started",
      payload: { agentRunId: run.id, role: "Coordinator", runtime: "hermes", collaboration: blueprint.collaboration },
    });

    await client.query("commit");

    return {
      id: task.id,
      accountId: task.account_id,
      workspaceId: task.workspace_id,
      runtimeCellId: task.runtime_cell_id,
      projectId: task.project_id,
      title: task.title,
      instructions: task.instructions,
      soulId: soul.id,
      runtimeSessionId: session.id,
      agentRunId: run.id,
      worktreePath,
      workspacePath,
      conversationContext,
      turnId: task.turn_id,
      routeDecision,
      resumeStoredSessionId,
      blueprintId,
      blueprint,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function markRunId(
  pool: pg.Pool,
  redis: Redis,
  task: ClaimedTask,
  run: HermesRunStatus & { run_id?: string; stored_session_id?: string },
): Promise<void> {
  const hermesRunId = run.run_id;
  if (!hermesRunId || !run.session_id) {
    throw new Error("Hermes JSON-RPC run identity is incomplete");
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `
        update runtime_sessions
        set hermes_run_id = $1, hermes_session_id = $2, hermes_live_session_id = $3, updated_at = now()
        where id = $4
      `,
      [hermesRunId, run.stored_session_id || run.session_id, run.session_id, task.runtimeSessionId],
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

async function updateLiveSessionId(pool: pg.Pool, task: ClaimedTask, runtimeSessionId: string): Promise<void> {
  await pool.query(
    "update runtime_sessions set hermes_live_session_id = $2, updated_at = now() where id = $1",
    [task.runtimeSessionId, runtimeSessionId],
  );
}

async function recordApprovalRequest(
  pool: pg.Pool,
  redis: Redis,
  task: ClaimedTask,
  payload: Record<string, unknown>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query<{ id: string }>(
      `
        insert into approvals (task_id, agent_run_id, type, summary, payload)
        select $1, $2, 'hermes.gateway', $3, $4::jsonb
        where not exists (
          select 1 from approvals
          where task_id = $1 and agent_run_id = $2 and status = 'requested'
        )
        returning id
      `,
      [
        task.id,
        task.agentRunId,
        String(payload.description || payload.command || "Hermes approval required").slice(0, 500),
        JSON.stringify(payload),
      ],
    );
    const approvalId = inserted.rows[0]?.id;
    await client.query("update tasks set status = 'reviewing', updated_at = now() where id = $1", [task.id]);
    await client.query(
      "update agent_runs set status = 'waiting_approval', updated_at = now() where id = $1",
      [task.agentRunId],
    );
    if (approvalId) {
      await appendEvent(client, redis, {
        projectId: task.projectId,
        taskId: task.id,
        type: "approval.requested",
        payload: { approvalId, command: payload.command || null, description: payload.description || null },
      });
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function syncSpecialistAssignments(
  client: pg.PoolClient,
  blueprintId: string,
  events: unknown[],
): Promise<{ completed: number; failed: number }> {
  const rows = await client.query<{ id: string; role_name: string; status: string; hermes_subagent_id: string | null }>(
    `
      select id, role_name, status, hermes_subagent_id
      from specialist_assignments
      where blueprint_id = $1
      order by created_at asc
      for update
    `,
    [blueprintId],
  );
  for (const rawEvent of events) {
    if (!rawEvent || typeof rawEvent !== "object") continue;
    const event = rawEvent as { type?: unknown; payload?: unknown };
    if (event.type !== "subagent.start" && event.type !== "subagent.complete") continue;
    const payload = event.payload && typeof event.payload === "object"
      ? event.payload as Record<string, unknown>
      : {};
    const childId = typeof payload.child_session_id === "string"
      ? payload.child_session_id
      : typeof payload.id === "string"
        ? payload.id
        : null;
    const description = [payload.preview, payload.goal, payload.name]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();
    const matchingRole = rows.rows.find((row) => description.includes(row.role_name.toLowerCase()));
    const matchingChild = childId ? rows.rows.find((row) => row.hermes_subagent_id === childId) : undefined;
    const assignment = matchingChild
      || matchingRole
      || rows.rows.find((row) => event.type === "subagent.start" ? row.status === "planned" : row.status === "running")
      || rows.rows.find((row) => row.status === "planned");
    if (!assignment) continue;

    if (event.type === "subagent.start") {
      assignment.status = "running";
      assignment.hermes_subagent_id = childId;
      await client.query(
        `
          update specialist_assignments
          set status = 'running', hermes_subagent_id = coalesce($2, hermes_subagent_id),
              started_at = coalesce(started_at, now()), updated_at = now()
          where id = $1
        `,
        [assignment.id, childId],
      );
      continue;
    }

    const eventStatus = typeof payload.status === "string" ? payload.status : "completed";
    const completed = ["completed", "complete", "success", "ok"].includes(eventStatus);
    assignment.status = completed ? "completed" : "failed";
    assignment.hermes_subagent_id = childId || assignment.hermes_subagent_id;
    const summary = typeof payload.summary === "string"
      ? payload.summary
      : typeof payload.result === "string"
        ? payload.result
        : null;
    await client.query(
      `
        update specialist_assignments
        set status = $2,
            hermes_subagent_id = coalesce($3, hermes_subagent_id),
            result_summary = $4,
            completed_at = now(),
            updated_at = now()
        where id = $1
      `,
      [assignment.id, assignment.status, childId, summary],
    );
  }

  const completed = rows.rows.filter((row) => row.status === "completed").length;
  const failed = rows.rows.filter((row) => row.status === "failed").length;
  await client.query(
    `
      update orchestration_blueprints
      set status = $2, updated_at = now()
      where id = $1
    `,
    [blueprintId, failed > 0 ? "failed" : completed === rows.rows.length ? "synthesizing" : "delegating"],
  );
  return { completed, failed };
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
    const specialistState = await syncSpecialistAssignments(client, task.blueprintId, run.events || []);

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
      await updateTaskPlan(
        client,
        redis,
        { id: task.id, projectId: task.projectId },
        (steps) =>
          steps.map((step) =>
            step.status === "running"
              ? {
                  ...step,
                  status: "blocked",
                }
              : step,
          ),
        "task.plan.step.failed",
        { hermesRunId, reason: "Hermes run is waiting for approval" },
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
      await updateTaskPlan(
        client,
        redis,
        { id: task.id, projectId: task.projectId },
        (steps) =>
          steps.map((step) =>
            step.status === "completed"
              ? step
              : {
                  ...step,
                  status: "failed",
                },
          ),
        "task.plan.step.failed",
        { hermesRunId, status: status || "failed" },
      );
      await client.query(
        `
          insert into verification_results (project_id, task_id, kind, status, confidence, summary, metadata)
          values ($1, $2, 'hermes.run', 'failed', 0.75, $3, $4::jsonb)
        `,
        [
          task.projectId,
          task.id,
          `Hermes run ${hermesRunId} ended with ${status || "failed"}.`,
          JSON.stringify({ hermesRunId, status: status || "failed" }),
        ],
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

    if (task.routeDecision.reasonCodes.includes("completion-required")) {
      const evidence = JSON.stringify(run.events || []).toLowerCase();
      const missing = [
        !/(test|pytest|playwright|vitest|jest)/.test(evidence) ? "test" : null,
        !/(build|typecheck|tsc)/.test(evidence) ? "build-or-typecheck" : null,
        !/(smoke|health|curl|playwright|browser|runtime)/.test(evidence) ? "runtime-verification" : null,
      ].filter((value): value is string => Boolean(value));
      if (missing.length > 0) {
        throw new Error(`Product completion evidence is incomplete: ${missing.join(", ")}`);
      }
    }

    const output = run.output || `Hermes run ${hermesRunId} completed.`;
    if (specialistState.failed > 0 || specialistState.completed < task.blueprint.specialists.length) {
      throw new Error(
        `Specialist collaboration incomplete: completed=${specialistState.completed}, failed=${specialistState.failed}, expected=${task.blueprint.specialists.length}`,
      );
    }
    const assistantMessageResult = await client.query<{ id: string }>(
      `
        insert into chat_messages (project_id, task_id, role, source, content, metadata)
        values ($1, $2, 'assistant', $3, $4, $5::jsonb)
        returning id
      `,
      [
        task.projectId,
        task.id,
        task.blueprint.specialists.length === 0 ? "hermes-direct" : "hermes-coordinator",
        output,
        JSON.stringify({
          hermesRunId,
          classification: {
            domain: task.blueprint.domain,
            secondaryDomains: task.blueprint.secondaryDomains,
            weight: task.blueprint.weight,
            riskSignals: task.blueprint.riskSignals,
          },
          specialistCount: specialistState.completed,
          collaboration: task.blueprint.collaboration,
          verified: task.blueprint.requireEvidence,
        }),
      ],
    );
    const assistantMessageId = assistantMessageResult.rows[0]?.id;
    if (!assistantMessageId) throw new Error("Verified assistant message insert did not return a row");
    if (task.blueprint.specialists.length === 0) {
      await client.query(
        "update agent_runs set status = 'completed', completed_at = now(), updated_at = now() where id = $1",
        [task.agentRunId],
      );
      await client.query("update tasks set status = 'completed', updated_at = now() where id = $1", [task.id]);
      await client.query("update orchestration_blueprints set status = 'verified', updated_at = now() where id = $1", [task.blueprintId]);
      if (task.turnId) {
        await client.query("update task_turns set status = 'completed', completed_at = now() where id = $1", [task.turnId]);
      }
      await appendEvent(client, redis, {
        projectId: task.projectId,
        taskId: task.id,
        type: "chat.message.completed",
        payload: { role: "assistant", messageId: assistantMessageId, hermesRunId, specialistCount: 0, verified: false },
      });
      if (task.turnId) {
        await appendEvent(client, redis, {
          projectId: task.projectId,
          taskId: task.id,
          type: "task.turn.completed",
          payload: { turnId: task.turnId, route: task.routeDecision.route, status: "completed" },
        });
      }
      await appendEvent(client, redis, {
        projectId: task.projectId,
        taskId: task.id,
        type: "task.completed",
        payload: { agentRunId: task.agentRunId, hermesRunId, status: "completed", summary: output.slice(0, 240) },
      });
      await client.query("commit");
      return;
    }
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
        insert into artifacts (account_id, workspace_id, project_id, task_id, kind, uri, checksum, metadata)
        values ($1, $2, $3, $4, 'hermes.run.output', $5, $6, $7::jsonb)
      `,
      [
        task.accountId,
        task.workspaceId,
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

    const verificationResult = await client.query<{ id: string }>(
      `
        insert into verification_results (project_id, task_id, kind, status, confidence, summary, metadata)
        values ($1, $2, 'hermes.run', 'passed', 0.92, $3, $4::jsonb)
        returning id
      `,
      [
        task.projectId,
        task.id,
        `Hermes run ${hermesRunId} completed and checkpoint was created.`,
        JSON.stringify({
          hermesRunId,
          checkpointId: checkpointResult.rows[0]?.id || null,
          artifactUri,
          changedFiles,
        }),
      ],
    );
    const verificationResultId = verificationResult.rows[0]?.id || null;

    await executeDevicePlanSteps(client, redis, task);

    const devicePlanResult = await client.query<{ steps: unknown }>("select steps from task_plans where task_id = $1", [task.id]);
    const devicePlanSteps = Array.isArray(devicePlanResult.rows[0]?.steps)
      ? (devicePlanResult.rows[0]?.steps as PlanStep[])
      : [];
    const hasFailedDeviceStep = devicePlanSteps.some((step) => step.type === "device.command" && step.status === "failed");
    const hasBlockedDeviceStep = devicePlanSteps.some((step) => step.type === "device.command" && step.status === "blocked");
    const finalTaskStatus: "completed" | "failed" | "blocked" = hasFailedDeviceStep
      ? "failed"
      : hasBlockedDeviceStep
        ? "blocked"
        : "completed";
    const finalVerificationStepStatus: PlanStep["status"] =
      finalTaskStatus === "failed" ? "failed" : finalTaskStatus === "blocked" ? "blocked" : "completed";

    await updateTaskPlan(
      client,
      redis,
      { id: task.id, projectId: task.projectId },
      (steps) =>
        steps.map((step) => {
          if (
            step.type === "device.command" &&
            (step.status === "completed" || step.status === "failed" || step.status === "blocked")
          ) {
            return step;
          }
          if (step.type === "verification.check") {
            return {
              ...step,
              status: finalVerificationStepStatus,
              verificationResultId,
            };
          }
          if (step.status === "failed" || step.status === "blocked") {
            return step;
          }
          return {
            ...step,
            status: "completed",
          };
        }),
      finalTaskStatus === "completed" ? "task.plan.step.completed" : "task.plan.step.failed",
      { hermesRunId, verificationResultId, devicePlanStatus: finalTaskStatus },
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
        set status = $2, updated_at = now()
        where id = $1
      `,
      [task.id, finalTaskStatus],
    );
    await client.query(
      "update orchestration_blueprints set status = 'verified', updated_at = now() where id = $1",
      [task.blueprintId],
    );
    if (task.turnId) {
      await client.query(
        "update task_turns set status = $2, completed_at = now() where id = $1",
        [task.turnId, finalTaskStatus === "completed" ? "completed" : "failed"],
      );
    }

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
    if (task.turnId) {
      await appendEvent(client, redis, {
        projectId: task.projectId,
        taskId: task.id,
        type: finalTaskStatus === "completed" ? "task.turn.completed" : "task.turn.failed",
        payload: { turnId: task.turnId, route: task.routeDecision.route, status: finalTaskStatus },
      });
    }
    await appendEvent(client, redis, {
      projectId: task.projectId,
      taskId: task.id,
      type: "verification.created",
      payload: {
        verificationResultId,
        kind: "hermes.run",
        status: "passed",
      },
    });
    await appendEvent(client, redis, {
      projectId: task.projectId,
      taskId: task.id,
      type: "chat.message.completed",
      payload: {
        role: "assistant",
        messageId: assistantMessageId,
        hermesRunId,
        specialistCount: specialistState.completed,
        verified: true,
      },
    });
    await appendEvent(client, redis, {
      projectId: task.projectId,
      taskId: task.id,
      type: finalTaskStatus === "completed" ? "task.completed" : "task.failed",
      payload: {
        agentRunId: task.agentRunId,
        hermesRunId,
        status: finalTaskStatus,
        summary:
          finalTaskStatus === "completed"
            ? output.slice(0, 240)
            : `Hermes completed, but device plan ended as ${finalTaskStatus}.`,
      },
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
    await client.query(
      "update orchestration_blueprints set status = 'failed', updated_at = now() where id = $1",
      [task.blueprintId],
    );
    if (task.turnId) {
      await client.query(
        "update task_turns set status = 'failed', failure_code = 'orchestrator_exception', failure_message = $2, completed_at = now() where id = $1",
        [task.turnId, message.slice(0, 2000)],
      );
    }
    await client.query(
      `
        update specialist_assignments
        set status = 'failed', completed_at = now(), updated_at = now()
        where blueprint_id = $1
          and status in ('planned', 'running')
      `,
      [task.blueprintId],
    );
    await updateTaskPlan(
      client,
      redis,
      { id: task.id, projectId: task.projectId },
      (steps) =>
        steps.map((step) =>
          step.status === "completed"
            ? step
            : {
                ...step,
                status: "failed",
              },
        ),
      "task.plan.step.failed",
      { agentRunId: task.agentRunId, message },
    );
    await client.query(
      `
        insert into verification_results (project_id, task_id, kind, status, confidence, summary, metadata)
        values ($1, $2, 'orchestrator.exception', 'failed', 0.85, $3, $4::jsonb)
      `,
      [
        task.projectId,
        task.id,
        `Orchestrator failed: ${message.slice(0, 240)}`,
        JSON.stringify({ agentRunId: task.agentRunId, message }),
      ],
    );
    await appendEvent(client, redis, {
      projectId: task.projectId,
      taskId: task.id,
      type: "task.failed",
      payload: { agentRunId: task.agentRunId, message },
    });
    if (task.turnId) {
      await appendEvent(client, redis, {
        projectId: task.projectId,
        taskId: task.id,
        type: "task.turn.failed",
        payload: { turnId: task.turnId, message },
      });
    }
    await client.query("commit");
  } catch (nestedError) {
    await client.query("rollback");
    throw nestedError;
  } finally {
    client.release();
  }
}

async function runOneCycle(
  pool: pg.Pool,
  redis: Redis,
  scope: { accountId: string; workspaceId: string; runtimeCellId: string },
  router: HermesRoutingSpecialist,
): Promise<boolean> {
  const preview = await previewTask(pool, scope.runtimeCellId);
  if (!preview) return false;
  let systemContext: RoutingSystemContext;
  try {
    systemContext = routingSystemContext(preview);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failRouting(pool, redis, preview.id, message, "invalid_workspace_path");
    return true;
  }
  let routingError: unknown = null;
  let routed: Awaited<ReturnType<HermesRoutingSpecialist["classify"]>> | null = null;
  let routingSessionId: string | null = null;
  let totalDurationMs = 0;
  for (let attempt = 1; attempt <= 2 && !routed; attempt += 1) {
    const attemptStartedAt = Date.now();
    routingSessionId = null;
    await startRoutingAttempt(pool, preview.turnId, attempt);
    try {
      await router.prepare();
      routingSessionId = await persistRoutingSession(pool, scope, router);
      routed = await router.classify(
        preview.instructions,
        preview.conversationContext,
        systemContext,
        (screening, durationMs) => recordRoutingScreening(pool, redis, preview, screening, durationMs, attempt),
      );
      const durationMs = Date.now() - attemptStartedAt;
      totalDurationMs += durationMs;
      await finishRoutingAttempt(pool, {
        turnId: preview.turnId,
        attempt,
        routingSessionId,
        status: "valid",
        durationMs,
        outputHash: routed.hash,
      });
    } catch (error) {
      routingError = error;
      const durationMs = Date.now() - attemptStartedAt;
      totalDurationMs += durationMs;
      const errorCode = routingErrorCode(error);
      await finishRoutingAttempt(pool, {
        turnId: preview.turnId,
        attempt,
        routingSessionId,
        status: errorCode === "invalid_output" ? "invalid" : "failed",
        durationMs,
        errorCode,
      });
      if (attempt >= 2 || !routingErrorIsRetryable(error)) break;
    }
  }
  if (!routed) {
    const message = routingError instanceof Error ? routingError.message : String(routingError || "Routing Agent failed");
    await failRouting(pool, redis, preview.id, message);
    throw routingError;
  }
  const routing: RoutingResult = { ...routed, durationMs: totalDurationMs, routingSessionId };
  const task = await claimTask(pool, redis, scope.runtimeCellId, preview.id, routing);
  if (!task) {
    return false;
  }

  try {
    if ((task.routeDecision.route === "instant" || task.routeDecision.route === "direct") && task.routeDecision.directAnswer) {
      await completeTask(pool, redis, task, `router-${task.turnId || task.id}`, {
        status: "completed",
        output: task.routeDecision.directAnswer,
        model: "termes-routing-agent",
        events: [],
      });
      return true;
    }
    const run = await executeHermesJsonRpcRun({
      managerUrl: hermesManagerUrl(),
      serviceToken: hermesManagerServiceToken(),
      realtimeBaseUrl: apiBaseUrl(),
      projectId: task.projectId,
      taskId: task.id,
      cwd: task.workspacePath,
      title: task.title,
      prompt: [
        "Conversation context (the final USER entry is the current request):",
        task.conversationContext,
      ].join("\n\n"),
      coordinatorInstructions: [
        coordinatorInstructions(task.blueprint, task.blueprint.specialists.length === 0
          ? `Current user request: ${task.instructions}`
          : [
              `Current user request: ${task.instructions}`,
              `Project workspace (exclusive allowed root): ${task.workspacePath}`,
              "Read the current files in that workspace directly. Do not ask for scope that is already present here.",
              "Never inspect or modify /opt/hermes, /opt/data, ~/.hermes, or Hermes internal Kanban state. Task, job, and card terms refer to the user's selected project, not Hermes' own task board.",
            ].join("\n")),
        `Work only inside ${task.workspacePath}. Treat every path outside it as denied.`,
        ...(task.routeDecision.reasonCodes.includes("completion-required") ? [
          "Completion contract: inspect current code, implement the requested product outcome, run relevant tests, run typecheck or production build, verify the actual runtime or UI flow, and report the concrete evidence. Do not finish before every step succeeds.",
        ] : []),
        `Task title: ${task.title}`,
        `Target project workspace: ${task.workspacePath}`,
      ].join("\n"),
      expectedSpecialists: task.blueprint.specialists.filter((specialist) => specialist.required).length,
      executionMode: task.blueprint.specialists.length === 0 ? "direct" : "specialist",
      ...(task.resumeStoredSessionId ? { existingStoredSessionId: task.resumeStoredSessionId } : {}),
      requireEvidence: task.blueprint.requireEvidence,
      timeoutMs: runTimeoutMs(),
      onSessionCreated: ({ runId, runtimeSessionId, storedSessionId }) =>
        markRunId(pool, redis, task, {
          run_id: runId,
          session_id: runtimeSessionId,
          stored_session_id: storedSessionId,
        }),
      onSessionResumed: ({ runtimeSessionId }) => updateLiveSessionId(pool, task, runtimeSessionId),
      onApprovalRequested: (payload) => recordApprovalRequest(pool, redis, task, payload),
    });
    await completeTask(pool, redis, task, run.run_id, run);
  } catch (error) {
    await failTask(pool, redis, task, error);
    throw error;
  }

  return true;
}

async function recoverInterruptedRuns(pool: pg.Pool, redis: Redis): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const interrupted = await client.query<{
      task_id: string;
      project_id: string;
      agent_run_id: string;
    }>(
      `
        select
          t.id as task_id,
          t.project_id,
          (
            select ar.id
            from agent_runs ar
            where ar.task_id = t.id and ar.status = 'running'
            order by ar.started_at desc
            limit 1
          ) as agent_run_id
        from tasks t
        where t.status = 'running'
          and exists (
            select 1 from agent_runs ar
            where ar.task_id = t.id and ar.status = 'running'
          )
        order by t.id
        for update of t
      `,
    );
    if (interrupted.rows.length === 0) {
      await client.query("commit");
      return 0;
    }

    const taskIds = interrupted.rows.map((row) => row.task_id);
    await client.query(
      `
        update agent_runs
        set status = 'cancelled', completed_at = now(), updated_at = now()
        where task_id = any($1::uuid[]) and status = 'running'
      `,
      [taskIds],
    );
    await client.query(
      `
        update tasks
        set status = 'created', updated_at = now()
        where id = any($1::uuid[]) and status = 'running'
      `,
      [taskIds],
    );
    for (const row of interrupted.rows) {
      await appendEvent(client, redis, {
        projectId: row.project_id,
        taskId: row.task_id,
        type: "task.requeued",
        payload: {
          reason: "orchestrator_restart",
          interruptedAgentRunId: row.agent_run_id,
        },
      });
    }
    await client.query("commit");
    return interrupted.rows.length;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: requiredEnv("DATABASE_URL") });
  const redis = new Redis(requiredEnv("REDIS_URL"), {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  });
  await redis.connect();
  const turnEvents = redis.duplicate({ maxRetriesPerRequest: null });
  await turnEvents.connect();
  try {
    await turnEvents.xgroup("CREATE", TERMES_TURN_STREAM, "termes-orchestrator", "0", "MKSTREAM");
  } catch (error) {
    if (!/BUSYGROUP/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }

  const app = Fastify({ logger: true });
  const eventOutbox = new EventOutboxDispatcher(pool, redis, {
    onError: (error) => app.log.error({ err: error }, "Event outbox dispatch failed"),
  });
  eventOutbox.start();
  const recoveredTasks = await recoverInterruptedRuns(pool, redis);
  let processedTasks = 0;
  let closing = false;
  let turnConsumer: Promise<void> | null = null;
  const activeCellRuns = new Map<string, Promise<boolean>>();
  const routers = new Map<string, HermesRoutingSpecialist>();
  let sharedOauthExecutionLane: Promise<void> = Promise.resolve();
  let schedulingCells: Promise<Array<Promise<boolean>>> | null = null;

  app.get("/healthz", async () => {
    await pool.query("select 1");
    await redis.ping();

    return {
      service: "orchestrator",
      version: TERMES_VERSION,
      status: "ok",
      processedTasks,
      recoveredTasks,
      activeRuntimeCells: [...activeCellRuns.keys()],
      routingSpecialists: [...routers.entries()].map(([runtimeCellId, router]) => ({
        runtimeCellId,
        ready: router.identity.ready,
        prepared: router.identity.prepared,
        storedSessionId: router.identity.storedSessionId || null,
      })),
      hermesManagerUrl: hermesManagerUrl(),
      checkedAt: new Date().toISOString(),
    };
  });

  app.addHook("onClose", async () => {
    closing = true;
    clearInterval(scheduler);
    turnEvents.disconnect();
    await turnConsumer;
    await Promise.allSettled(activeCellRuns.values());
    for (const router of routers.values()) router.close();
    await eventOutbox.stop();
    redis.disconnect();
    await pool.end();
  });

  const scheduleCellsOnce = async (): Promise<Array<Promise<boolean>>> => {
    if (closing) return [];
    const scheduled: Array<Promise<boolean>> = [];
    const cells = await pool.query<{
      id: string;
      account_id: string;
      workspace_id: string;
      hermes_stored_session_id: string | null;
    }>(
      `
        select rc.id, rc.account_id, rc.workspace_id, rs.hermes_stored_session_id
        from runtime_cells rc
        left join routing_sessions rs on rs.runtime_cell_id = rc.id and rs.policy_version = ${ROUTING_POLICY_VERSION}
        where rc.status = 'active'
        order by rc.id
      `,
    );
    for (const cell of cells.rows) {
      let router = routers.get(cell.id);
      if (!router) {
        router = new HermesRoutingSpecialist({
          managerUrl: hermesManagerUrl(),
          serviceToken: hermesManagerServiceToken(),
          accountId: cell.account_id,
          workspaceId: cell.workspace_id,
          runtimeCellId: cell.id,
          cwd: "/workspace",
          timeoutMs: 30_000,
          preparationTimeoutMs: 60_000,
          storedSessionId: cell.hermes_stored_session_id,
        });
        routers.set(cell.id, router);
      }
    }

    for (const cell of cells.rows) {
      const existingRun = activeCellRuns.get(cell.id);
      if (existingRun) scheduled.push(existingRun);
    }
    if (activeCellRuns.size > 0) return scheduled;

    for (const cell of cells.rows) {
      const router = routers.get(cell.id);
      if (!router) throw new Error(`Routing Agent was not created for runtime cell ${cell.id}`);
      if (router.identity.prepared) continue;
      try {
        await router.prepare();
        await persistRoutingSession(pool, {
          accountId: cell.account_id,
          workspaceId: cell.workspace_id,
          runtimeCellId: cell.id,
        }, router);
      } catch (error) {
        app.log.error({ err: error, runtimeCellId: cell.id }, "Routing Agent preparation failed");
        scheduled.push(Promise.resolve(false));
        return scheduled;
      }
    }

    for (const cell of cells.rows) {
      const router = routers.get(cell.id);
      if (!router) throw new Error(`Routing Agent was not created for runtime cell ${cell.id}`);
      const run = sharedOauthExecutionLane
        .catch(() => undefined)
        .then(() => runOneCycle(pool, redis, {
          accountId: cell.account_id,
          workspaceId: cell.workspace_id,
          runtimeCellId: cell.id,
        }, router))
        .then((processed) => {
          if (processed) processedTasks += 1;
          return true;
        })
        .catch((error: unknown) => {
          app.log.error({ err: error, runtimeCellId: cell.id }, "Account cell orchestration failed");
          return false;
        })
        .finally(() => {
          activeCellRuns.delete(cell.id);
        });
      sharedOauthExecutionLane = run.then(() => undefined, () => undefined);
      activeCellRuns.set(cell.id, run);
      scheduled.push(run);
    }
    return scheduled;
  };
  const scheduleCells = (): Promise<Array<Promise<boolean>>> => {
    if (schedulingCells) return schedulingCells;
    const scheduling = scheduleCellsOnce();
    schedulingCells = scheduling;
    void scheduling.finally(() => {
      if (schedulingCells === scheduling) schedulingCells = null;
    });
    return scheduling;
  };
  const consumeTurnStream = async () => {
    let cursor = "0";
    while (!closing) {
      try {
        const response = await turnEvents.xreadgroup(
          "GROUP", "termes-orchestrator", "orchestrator",
          "COUNT", 20,
          "BLOCK", 5_000,
          "STREAMS", TERMES_TURN_STREAM, cursor,
        ) as unknown as Array<[string, Array<[string, string[]]>]> | null;
        const messages = response?.flatMap(([, entries]) => entries) ?? [];
        if (cursor === "0" && messages.length === 0) {
          cursor = ">";
          continue;
        }
        let batchFailed = false;
        for (const [streamId] of messages) {
          const scheduled = await scheduleCells();
          const succeeded = (await Promise.all(scheduled)).every(Boolean);
          if (succeeded) {
            await turnEvents.xack(TERMES_TURN_STREAM, "termes-orchestrator", streamId);
          } else {
            batchFailed = true;
            cursor = "0";
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            break;
          }
        }
        if (cursor === "0" && !batchFailed) cursor = ">";
      } catch (error) {
        if (!closing) app.log.error({ err: error }, "Turn stream consumer failed");
      }
    }
  };
  turnConsumer = consumeTurnStream();
  const scheduler = setInterval(() => { void scheduleCells(); }, 30_000);
  scheduler.unref();
  await scheduleCells();

  await app.listen({ host: "0.0.0.0", port: port() });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

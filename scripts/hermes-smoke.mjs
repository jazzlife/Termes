#!/usr/bin/env node

const args = process.argv.slice(2);
const requireUpstream = args.includes("--require-upstream") || process.env.TERMES_REQUIRE_UPSTREAM === "true";
const targetArg = args.find((arg) => !arg.startsWith("--"));
const baseUrl = (process.env.TERMES_BASE_URL || targetArg || "http://100.64.0.9:4180").replace(/\/+$/, "");
const hermesBase = `${baseUrl}/api/hermes`;
const auditId = Date.now().toString(36);
const results = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function record(name, detail = "ok") {
  results.push({ name, detail });
  console.log(`ok ${results.length} ${name} ${detail}`);
}

function listData(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object" && Array.isArray(value.data)) {
    return value.data;
  }

  return [];
}

async function request(path, init = {}) {
  const response = await fetch(`${hermesBase}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${path} returned ${response.status}: ${text}`);
  }

  return body;
}

async function stream(path, init = {}) {
  const response = await fetch(`${hermesBase}${path}`, {
    ...init,
    headers: {
      accept: "text/event-stream",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${init.method || "GET"} ${path} stream returned ${response.status}: ${text}`);
  }
  if (!response.body) {
    return [];
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];

  function emit(block) {
    const event = { event: "message", data: "" };
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event.event = line.slice("event:".length).trim();
      }
      if (line.startsWith("data:")) {
        event.data += `${line.slice("data:".length).trimStart()}\n`;
      }
    }
    if (event.data.trim()) {
      events.push({ ...event, data: event.data.trim() });
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      if (block.trim()) {
        emit(block);
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    emit(buffer);
  }

  return events;
}

async function main() {
  console.log(`# Termes Hermes smoke target: ${baseUrl}`);

  const capabilities = await request("/capabilities");
  assert(capabilities.features?.chat_completions, "chat completions feature is not advertised");
  assert(capabilities.features?.responses_api, "responses feature is not advertised");
  assert(capabilities.features?.sessions, "sessions feature is not advertised");
  assert(capabilities.features?.jobs, "jobs feature is not advertised");
  record("capabilities", `${Object.values(capabilities.features || {}).filter(Boolean).length} features`);

  const health = await request("/health/detailed");
  assert(health.status === "ok", "Hermes detailed health is not ok");
  record("health_detailed", `runs=${health.runs ?? "unknown"}`);

  const diagnostics = await request("/upstream/diagnostics");
  if (requireUpstream) {
    assert(diagnostics.ready === true, `official Hermes upstream is not ready: ${JSON.stringify(diagnostics)}`);
  }
  record("upstream_diagnostics", diagnostics.ready ? "ready" : "not_ready");

  const [models, skills, toolsets, profiles] = await Promise.all([
    request("/v1/models"),
    request("/v1/skills"),
    request("/v1/toolsets"),
    request("/profiles"),
  ]);
  assert(Array.isArray(models.data) && models.data.length > 0, "model list is empty");
  const skillList = listData(skills);
  const toolsetList = listData(toolsets);
  assert(skillList.length > 0, "skills response is empty or not list-like");
  assert(toolsetList.length > 0, "toolsets response is empty or not list-like");
  assert(Array.isArray(profiles.profiles), "profiles response is not a list");
  record("catalog", `models=${models.data.length} skills=${skillList.length} toolsets=${toolsetList.length}`);

  if (diagnostics.baseUrlConfigured && diagnostics.ready !== true) {
    throw new Error(`official Hermes upstream is configured but not ready: ${JSON.stringify(diagnostics)}`);
  }

  const prompt = `Termes Hermes smoke ${auditId}`;
  const chat = await request("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "hermes-agent",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  assert(Array.isArray(chat.choices) && chat.choices.length > 0, "chat completion returned no choices");
  record("chat_completion", chat.id || "created");

  const chatEvents = await stream("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "hermes-agent",
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  assert(chatEvents.length > 0, "chat completion stream returned no events");
  record("chat_stream", `${chatEvents.length} events`);

  const chatSessionId = `smokechat-${auditId}`;
  await request("/v1/chat/completions", {
    method: "POST",
    headers: { "x-hermes-session-id": chatSessionId },
    body: JSON.stringify({
      model: "hermes-agent",
      messages: [{ role: "user", content: `${prompt} session one` }],
    }),
  });
  await request("/v1/chat/completions", {
    method: "POST",
    headers: { "x-hermes-session-id": chatSessionId },
    body: JSON.stringify({
      model: "hermes-agent",
      messages: [{ role: "user", content: `${prompt} session two` }],
    }),
  });
  const chatSessionMessages = await request(`/api/sessions/${encodeURIComponent(chatSessionId)}/messages`);
  assert(
    Array.isArray(chatSessionMessages.messages) && chatSessionMessages.messages.length >= 4,
    "chat completion session continuity did not persist messages",
  );
  await request(`/api/sessions/${encodeURIComponent(chatSessionId)}`, { method: "DELETE" });
  record("chat_session_continuity", `${chatSessionMessages.messages.length} messages`);

  const conversation = `smoke-${auditId}`;
  const responseOne = await request("/v1/responses", {
    method: "POST",
    body: JSON.stringify({ input: prompt, conversation }),
  });
  assert(typeof responseOne.id === "string", "response did not return an id");
  const responseTwo = await request("/v1/responses", {
    method: "POST",
    body: JSON.stringify({ input: `${prompt} continued`, conversation }),
  });
  assert(responseTwo.previous_response_id === responseOne.id, "conversation did not continue from previous response");
  const responseEvents = await stream("/v1/responses", {
    method: "POST",
    body: JSON.stringify({ input: `${prompt} stream`, previous_response_id: responseTwo.id, stream: true }),
  });
  assert(responseEvents.length > 0, "responses stream returned no events");
  await request(`/v1/responses/${encodeURIComponent(responseTwo.id)}`, { method: "DELETE" });
  await request(`/v1/responses/${encodeURIComponent(responseOne.id)}`, { method: "DELETE" });
  record("responses", `${responseEvents.length} stream events`);

  const run = await request("/v1/runs", {
    method: "POST",
    body: JSON.stringify({ input: prompt, instructions: "Smoke test run lifecycle." }),
  });
  assert(typeof run.run_id === "string", "run create did not return run_id");
  const runEvents = await stream(`/v1/runs/${encodeURIComponent(run.run_id)}/events`);
  assert(runEvents.length > 0, "run events stream returned no events");
  const runStatus = await request(`/v1/runs/${encodeURIComponent(run.run_id)}`);
  assert(["running", "completed", "failed", "cancelled"].includes(runStatus.status), "run status is invalid");
  await request(`/v1/runs/${encodeURIComponent(run.run_id)}/approval`, {
    method: "POST",
    body: JSON.stringify({ decision: "approved" }),
  });
  const stopRun = await request("/v1/runs", {
    method: "POST",
    body: JSON.stringify({ input: "Stop smoke run.", instructions: "Create a run for stop endpoint." }),
  });
  await request(`/v1/runs/${encodeURIComponent(stopRun.run_id)}/stop`, { method: "POST" });
  record("runs", `${run.run_id}`);

  const profileName = `smoke-${auditId}`;
  await request("/profiles", {
    method: "POST",
    body: JSON.stringify({ name: profileName, codexRuntimeEnabled: true }),
  });
  await request(`/profiles/${encodeURIComponent(profileName)}`, { method: "DELETE" });
  record("profiles", profileName);

  const session = await request("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title: `Smoke ${auditId}`, source: "smoke" }),
  });
  assert(typeof session.id === "string", "session create did not return id");
  await request("/api/sessions?source=smoke");
  await request(`/api/sessions/${encodeURIComponent(session.id)}`);
  await request(`/api/sessions/${encodeURIComponent(session.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ title: `Smoke ${auditId} updated` }),
  });
  await request(`/api/sessions/${encodeURIComponent(session.id)}/messages`);
  await request(`/api/sessions/${encodeURIComponent(session.id)}/chat`, {
    method: "POST",
    body: JSON.stringify({ input: prompt }),
  });
  const sessionEvents = await stream(`/api/sessions/${encodeURIComponent(session.id)}/chat/stream`, {
    method: "POST",
    body: JSON.stringify({ input: `${prompt} stream` }),
  });
  assert(sessionEvents.length > 0, "session chat stream returned no events");
  const fork = await request(`/api/sessions/${encodeURIComponent(session.id)}/fork`, {
    method: "POST",
    body: JSON.stringify({ title: `Smoke ${auditId} fork` }),
  });
  assert(typeof fork.id === "string", "session fork did not return id");
  await request(`/api/sessions/${encodeURIComponent(fork.id)}`, { method: "DELETE" });
  await request(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
  record("sessions", `${sessionEvents.length} stream events`);

  const job = await request("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      prompt,
      schedule: "manual",
      skills: ["termes-orchestration"],
      provider: "smoke",
      delivery_target: "mobile",
    }),
  });
  assert(typeof job.job_id === "string", "job create did not return job_id");
  await request("/api/jobs");
  await request(`/api/jobs/${encodeURIComponent(job.job_id)}`);
  await request(`/api/jobs/${encodeURIComponent(job.job_id)}`, {
    method: "PATCH",
    body: JSON.stringify({ prompt: `${prompt} updated` }),
  });
  await request(`/api/jobs/${encodeURIComponent(job.job_id)}/pause`, { method: "POST" });
  await request(`/api/jobs/${encodeURIComponent(job.job_id)}/resume`, { method: "POST" });
  const jobRun = await request(`/api/jobs/${encodeURIComponent(job.job_id)}/run`, { method: "POST" });
  assert(typeof jobRun.run_id === "string", "job run did not return run_id");
  await request(`/api/jobs/${encodeURIComponent(job.job_id)}`, { method: "DELETE" });
  record("jobs", job.job_id);

  console.log(`# Passed ${results.length} Hermes smoke groups`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

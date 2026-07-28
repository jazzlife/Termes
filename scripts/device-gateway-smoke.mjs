const baseUrl = (process.env.TERMES_BASE_URL || "http://100.64.0.9:4180").replace(/\/+$/, "");
let sessionCookie = "";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
      ...(options.headers || {}),
    },
  }).catch((error) => {
    throw new Error(`${options.method || "GET"} ${url} network error: ${error instanceof Error ? error.message : String(error)}`);
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed ${response.status}: ${text}`);
  }
  return body;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function ensureLocalMockDevice(projectId) {
  const discovered = await request("/api/devices/discover", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
  const localMock = discovered.devices?.find((device) => device.platform === "local_mock");
  if (localMock) {
    return localMock;
  }
  const created = await request("/api/devices", {
    method: "POST",
    body: JSON.stringify({
      projectId,
      name: `Local Mock ${Date.now()}`,
      platform: "local_mock",
      transport: "local_mock",
      endpoint: "local://termes/device-gateway",
      labels: { source: "device-smoke" },
      status: "online",
    }),
  });
  return created.device;
}

async function runDeviceEditSmoke(projectId) {
  const suffix = Date.now().toString(36);
  const created = await request("/api/devices", {
    method: "POST",
    body: JSON.stringify({
      projectId,
      name: `Editable Local Mock ${suffix}`,
      platform: "local_mock",
      transport: "local_mock",
      endpoint: "local://termes/device-gateway",
      labels: { source: "device-smoke", editable: "true" },
      status: "online",
    }),
  });
  const deviceId = created.device?.id;
  assert(deviceId, "Editable smoke device must be created");

  const updatedName = `Editable Local Mock ${suffix} Updated`;
  const updated = await request(`/api/devices/${deviceId}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: updatedName,
      transport: "local_mock",
      endpoint: "local://termes/device-gateway",
      labels: { source: "device-smoke", editable: "true", updated: "true" },
      status: "online",
    }),
  });
  assert(updated.device?.name === updatedName, "Device update must persist the new name");
  assert(updated.device?.labels?.updated === "true", "Device update must persist labels");

  const listed = await request(`/api/devices?projectId=${encodeURIComponent(projectId)}`);
  assert(
    listed.devices?.some((device) => device.id === deviceId && device.name === updatedName),
    "Updated device must appear in the project device list",
  );

  await request(`/api/devices/${deviceId}`, { method: "DELETE" });
  const afterDelete = await request(`/api/devices?projectId=${encodeURIComponent(projectId)}`);
  assert(!afterDelete.devices?.some((device) => device.id === deviceId), "Deleted device must be removed from the device list");
  return { deviceId, updatedName };
}

async function runOptionalWindowsSmoke(projectId) {
  const endpoint = process.env.DEVICE_SMOKE_WINDOWS_ENDPOINT;
  if (!endpoint) {
    return { skipped: true };
  }
  const transport = process.env.DEVICE_SMOKE_WINDOWS_TRANSPORT === "winrm" ? "winrm" : "ssh";
  const created = await request("/api/devices", {
    method: "POST",
    body: JSON.stringify({
      projectId,
      name: `Windows Smoke ${Date.now()}`,
      platform: "windows",
      transport,
      endpoint,
      labels: { source: "device-smoke" },
      status: "unknown",
    }),
  });
  const result = await request(`/api/devices/${created.device.id}/commands`, {
    method: "POST",
    body: JSON.stringify({
      action: "windows.system.info",
      params: {},
    }),
  });
  if (transport === "winrm") {
    assert(
      result.command.status === "failed" && String(result.command.stderr || "").includes("transport_unavailable"),
      "Windows WinRM smoke must return transport_unavailable until a WinRM bridge is installed",
    );
  } else {
    assert(["completed", "failed"].includes(result.command.status), "Windows SSH smoke must produce a terminal command status");
  }
  return result.command;
}

async function runWinRmContractSmoke(projectId) {
  const created = await request("/api/devices", {
    method: "POST",
    body: JSON.stringify({
      projectId,
      name: `Windows WinRM Contract ${Date.now()}`,
      platform: "windows",
      transport: "winrm",
      endpoint: "winrm://termes-contract",
      labels: { source: "device-smoke", contract: "winrm" },
      status: "unknown",
    }),
  });
  const result = await request(`/api/devices/${created.device.id}/commands`, {
    method: "POST",
    body: JSON.stringify({
      action: "windows.system.info",
      params: {},
    }),
  });
  assert(result.command?.status === "failed", "Windows WinRM contract command must fail until a WinRM bridge is installed");
  assert(
    String(result.command.stderr || "").includes("transport_unavailable"),
    "Windows WinRM contract command must report transport_unavailable",
  );
  assert(result.verificationResult?.status === "failed", "Windows WinRM contract command must create failed verification result");
  return result.command;
}

async function waitForOrchestratedLocalMock(taskId) {
  const timeoutMs = Number.parseInt(process.env.DEVICE_SMOKE_ORCHESTRATOR_TIMEOUT_MS || "45000", 10);
  const deadline = Date.now() + timeoutMs;
  let lastRuntime = null;

  while (Date.now() < deadline) {
    const runtime = await request(`/api/tasks/${taskId}/runtime`);
    lastRuntime = runtime;
    const steps = Array.isArray(runtime.taskPlan?.steps) ? runtime.taskPlan.steps : [];
    const localMockStep = steps.find(
      (step) => step.type === "device.command" && step.capabilityKey === "local-mock-device",
    );
    const taskStatus = runtime.task?.status;

    if (localMockStep?.status === "failed" || localMockStep?.status === "blocked") {
      throw new Error(`Orchestrated local_mock step ended as ${localMockStep.status}: ${JSON.stringify(localMockStep)}`);
    }
    if (taskStatus === "failed" || taskStatus === "blocked") {
      throw new Error(`Orchestrated local_mock task ended as ${taskStatus}: ${JSON.stringify(runtime.taskPlan)}`);
    }
    if (localMockStep?.status === "completed" && localMockStep.deviceCommandId) {
      assert(taskStatus === "completed", "Task with completed local_mock device step must be completed");
      assert(runtime.taskPlan?.status === "completed", "Task plan with completed local_mock device step must be completed");
      const verifications = Array.isArray(runtime.verificationResults) ? runtime.verificationResults : [];
      const deviceVerification = verifications.find(
        (verification) =>
          verification.deviceCommandId === localMockStep.deviceCommandId && verification.kind === "device.command",
      );
      assert(deviceVerification?.status === "passed", "Orchestrated local_mock command must create passed verification");
      const events = Array.isArray(runtime.events) ? runtime.events : [];
      assert(
        events.some((event) => event.type === "device.command.completed" && event.payload?.deviceCommandId === localMockStep.deviceCommandId),
        "Orchestrated local_mock command must create a device.command.completed event",
      );
      assert(
        events.some((event) => event.type === "task.plan.step.completed" && event.payload?.deviceCommandId === localMockStep.deviceCommandId),
        "Orchestrated local_mock command must create a task.plan.step.completed event",
      );
      assert(
        events.some((event) => event.type === "verification.created" && event.payload?.verificationResultId === deviceVerification.id),
        "Orchestrated local_mock command must create a verification.created event",
      );
      return {
        taskStatus,
        planStatus: runtime.taskPlan.status,
        deviceCommandId: localMockStep.deviceCommandId,
        verificationResultId: localMockStep.verificationResultId,
        eventCount: events.length,
      };
    }

    await sleep(1000);
  }

  throw new Error(`Timed out waiting for orchestrated local_mock command: ${JSON.stringify(lastRuntime?.taskPlan || null)}`);
}

async function waitForTaskPlan(taskId) {
  const timeoutMs = Number.parseInt(process.env.DEVICE_SMOKE_ORCHESTRATOR_TIMEOUT_MS || "45000", 10);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await request(`/api/tasks/${taskId}/plan`);
    if (Array.isArray(result.taskPlan?.steps) && result.taskPlan.steps.length > 0) {
      return result.taskPlan;
    }
    const runtime = await request(`/api/tasks/${taskId}/runtime`);
    if (runtime.task?.status === "failed" || runtime.task?.status === "blocked") {
      throw new Error(`Task ended as ${runtime.task.status} before its plan became ready`);
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for task plan ${taskId}`);
}

async function main() {
  const email = process.env.TERMES_ACCOUNT_EMAIL || "master@termes.local";
  const password = process.env.TERMES_ACCOUNT_ACCESS_CODE || "";
  assert(password.length > 0, "TERMES_ACCOUNT_ACCESS_CODE is required for authenticated device smoke");
  const loginResponse = await fetch(`${baseUrl}/api/account-auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const loginText = await loginResponse.text();
  assert(loginResponse.ok, `Termes account login failed with ${loginResponse.status}: ${loginText}`);
  sessionCookie = (loginResponse.headers.get("set-cookie") || "").split(";")[0] || "";
  assert(sessionCookie.startsWith("termes_session="), "Termes account login did not return a session cookie");

  const health = await request("/api/healthz");
  assert(health.status === "ok", "API health must be ok");

  const projects = await request("/api/projects");
  assert(Array.isArray(projects.projects), "GET /api/projects must return projects array");

  const smokeKey = `device-smoke-${Date.now().toString(36)}`;
  let projectId = "";
  let localMockDeviceId = "";
  let localMockCommandId = "";
  let editableDevice = null;
  let orchestratedLocalMock = null;
  let winRmContractCommandId = "";
  let windowsSmoke = { skipped: true };
  let cleanup = { projectDeleted: false };
  try {
    const createdProject = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        key: smokeKey,
        name: `Device Smoke ${smokeKey}`,
        description: "Temporary project for device gateway smoke verification.",
      }),
    });
    const project = createdProject.project;
    assert(project?.id, "Temporary smoke project must be created");
    projectId = project.id;

    const devicesBefore = await request(`/api/devices?projectId=${encodeURIComponent(project.id)}`);
    assert(Array.isArray(devicesBefore.devices), "GET /api/devices must return devices array");

    const localMock = await ensureLocalMockDevice(project.id);
    localMockDeviceId = localMock.id;
    assert(localMock.platform === "local_mock", "local_mock device must be available");
    editableDevice = await runDeviceEditSmoke(project.id);

    const commandRun = await request(`/api/devices/${localMock.id}/commands`, {
      method: "POST",
      body: JSON.stringify({
        action: "local_mock.echo",
        params: { payload: "device smoke ok" },
      }),
    });
    localMockCommandId = commandRun.command?.id || "";
    assert(commandRun.command?.status === "completed", "local_mock.echo must complete");
    assert(String(commandRun.command.stdout || "").includes("device smoke ok"), "local_mock.echo stdout must contain payload");
    assert(commandRun.verificationResult?.status === "passed", "local_mock.echo must create passed verification result");

    const secretValue = `termes-secret-${Date.now()}`;
    const secretRun = await request(`/api/devices/${localMock.id}/commands`, {
      method: "POST",
      body: JSON.stringify({
        action: "local_mock.echo",
        params: { payload: { token: secretValue, visible: "ok" } },
      }),
    });
    assert(secretRun.command?.status === "completed", "Secret redaction smoke command must complete");
    assert(!String(secretRun.command.stdout || "").includes(secretValue), "Secret values must be redacted from command stdout");
    assert(String(secretRun.command.stdout || "").includes("[REDACTED]"), "Redacted stdout must contain the redaction marker");
    const secretLookup = await request(`/api/device-commands/${secretRun.command.id}`);
    assert(
      secretLookup.command?.params?.payload?.token === "[REDACTED]",
      "Secret command params must be redacted in the device command ledger",
    );

    const blockedRun = await request(`/api/devices/${localMock.id}/commands`, {
      method: "POST",
      body: JSON.stringify({
        action: "local_mock.echo",
        params: { payload: "rm -rf /" },
      }),
    });
    assert(blockedRun.command?.status === "blocked", "Dangerous command payload must be blocked before gateway execution");
    assert(blockedRun.verificationResult?.status === "warning", "Blocked command must create warning verification result");

    const commandLookup = await request(`/api/device-commands/${commandRun.command.id}`);
    assert(commandLookup.command?.id === commandRun.command.id, "Command lookup must return created command");

    const logs = await request(`/api/device-commands/${commandRun.command.id}/logs`);
    assert(String(logs.stdout || "").includes("device smoke ok"), "Command logs must include stdout");

    const capabilities = await request("/api/capabilities");
    assert(
      capabilities.capabilities?.some((capability) => capability.key === "local-mock-device"),
      "Capabilities must include local-mock-device",
    );

    const task = await request("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        projectId: project.id,
        title: `Device smoke ${new Date().toISOString()}`,
        instructions: "Run local_mock device smoke and verify the task plan.",
      }),
    });
    const taskId = task.task.id;
    const plan = await waitForTaskPlan(taskId);
    assert(plan.steps.length > 0, "Task plan must contain steps");
    assert(
      plan.selectedCapabilities.includes("local-mock-device"),
      "Task plan must select local-mock-device capability",
    );
    const verification = await request(`/api/tasks/${taskId}/verification-results`);
    assert(Array.isArray(verification.verificationResults), "Verification endpoint must return an array");
    orchestratedLocalMock = await waitForOrchestratedLocalMock(taskId);

    const winRmContract = await runWinRmContractSmoke(project.id);
    winRmContractCommandId = winRmContract.id;

    windowsSmoke = await runOptionalWindowsSmoke(project.id);
  } finally {
    if (projectId) {
      const deleted = await request(`/api/projects/${projectId}?removeWorkspace=true`, { method: "DELETE" });
      const workspaceCleanup = Array.isArray(deleted.workspaceCleanup) ? deleted.workspaceCleanup : [];
      cleanup = {
        projectDeleted: deleted.deleted === true,
        workspaceRemoved: workspaceCleanup.length > 0 && workspaceCleanup.every((entry) => entry.removed === true),
      };
    }
  }
  assert(cleanup.projectDeleted, "Temporary smoke project must be deleted");
  assert(cleanup.workspaceRemoved, "Temporary smoke workspace must be removed");

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        projectId,
        localMockDeviceId,
        localMockCommandId,
        editableDevice,
        orchestratedLocalMock,
        winRmContractCommandId,
        windowsSmoke,
        cleanup,
      },
      null,
    2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

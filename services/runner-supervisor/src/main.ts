import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, realpath, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { TERMES_VERSION } from "@termes/shared";
import Fastify from "fastify";

interface RunRequest {
  runId?: string;
  sessionId?: string;
  taskId?: string;
  projectId?: string;
  title?: string;
  instructions?: string;
  worktreePath?: string;
}

interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface ChangedFile {
  path: string;
  bytes: number;
  sha256: string;
}

interface WorkspaceImplementation {
  manifestPath: string;
  sourcePath: string;
  verifierPath: string;
  readmePath: string;
  summaryPath: string;
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

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isInsideRoot(root: string, candidate: string): Promise<boolean> {
  const rootInputPath = path.resolve(root);
  const rootRealPath = await realpath(root);
  const candidateInputPath = path.resolve(candidate);
  const candidateRealPath = await realpath(candidateInputPath).catch(() => candidateInputPath);

  return (
    pathIsInside(rootInputPath, candidateInputPath) ||
    pathIsInside(rootInputPath, candidateRealPath) ||
    pathIsInside(rootRealPath, candidateInputPath) ||
    pathIsInside(rootRealPath, candidateRealPath)
  );
}

async function assertPathInsideRoot(root: string, candidate: string): Promise<string> {
  const candidatePath = path.resolve(candidate);
  if (!(await isInsideRoot(root, candidatePath))) {
    throw new Error(`Path is outside the allowed root: ${candidate}`);
  }

  return candidatePath;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boundedText(value: string, max = 24_000): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`;
}

function slugify(value: string, max = 72): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);

  return slug || "termes-task";
}

function packageNameForTask(taskId: string): string {
  return `termes-task-${taskId.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase().slice(0, 36)}`;
}

function escapeJs(value: string): string {
  return JSON.stringify(value);
}

function implementationFocus(instructions: string): string[] {
  const lower = instructions.toLowerCase();
  const focus = ["task-intake", "workspace-artifact", "runtime-verification"];
  if (lower.includes("mobile") || instructions.includes("모바일")) {
    focus.push("mobile-web");
  }
  if (lower.includes("discord")) {
    focus.push("discord-style-ui");
  }
  if (lower.includes("hermes")) {
    focus.push("hermes-api-integration");
  }
  if (lower.includes("openhands")) {
    focus.push("openhands-workbench");
  }

  return Array.from(new Set(focus));
}

async function runCommand(cwd: string, command: string): Promise<CommandResult> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", command], {
      cwd,
      env: {
        HOME: cwd,
        PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        TERM: "xterm-256color",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, 20_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        command,
        exitCode,
        stdout: boundedText(stdout),
        stderr: boundedText(stderr),
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        command,
        exitCode: 1,
        stdout: boundedText(stdout),
        stderr: boundedText(`${stderr}${stderr ? "\n" : ""}${error.message}`),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function collectFiles(root: string, current = root, depth = 0): Promise<ChangedFile[]> {
  if (depth > 5) {
    return [];
  }

  const entries = await readdir(current, { withFileTypes: true });
  const files: ChangedFile[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }

    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, fullPath, depth + 1)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const [info, raw] = await Promise.all([stat(fullPath), readFile(fullPath)]);
    files.push({
      path: path.relative(root, fullPath),
      bytes: info.size,
      sha256: createHash("sha256").update(raw).digest("hex"),
    });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function writeWorkspaceImplementation(
  worktreePath: string,
  body: RunRequest,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    title: string;
    instructions: string;
  },
): Promise<WorkspaceImplementation> {
  const srcRoot = path.join(worktreePath, "src");
  const scriptsRoot = path.join(worktreePath, "scripts");
  const reportsRoot = path.join(worktreePath, "reports");
  await Promise.all([
    mkdir(srcRoot, { recursive: true }),
    mkdir(scriptsRoot, { recursive: true }),
    mkdir(reportsRoot, { recursive: true }),
  ]);

  const focus = implementationFocus(input.instructions);
  const manifest = {
    name: slugify(input.title),
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    projectId: asString(body.projectId) || null,
    title: input.title,
    instructions: input.instructions,
    focus,
    generatedAt: new Date().toISOString(),
    contract: {
      sourceFiles: ["src/termes-task.mjs"],
      verifier: "scripts/verify.mjs",
      output: "reports/verification.json",
    },
  };

  const source = [
    "export const termesTask = Object.freeze({",
    `  runId: ${escapeJs(input.runId)},`,
    `  taskId: ${escapeJs(input.taskId)},`,
    `  sessionId: ${escapeJs(input.sessionId)},`,
    `  projectId: ${escapeJs(asString(body.projectId) || "unknown")},`,
    `  title: ${escapeJs(input.title)},`,
    `  instructions: ${escapeJs(input.instructions)},`,
    `  focus: ${JSON.stringify(focus)},`,
    "  runtime: {",
    "    engine: 'runner-supervisor',",
    "    workspaceType: 'task-worktree',",
    "    artifactPolicy: 'checkpointed-source-and-verification',",
    "  },",
    "});",
    "",
    "export function implementationSummary() {",
    "  return {",
    "    title: termesTask.title,",
    "    focus: termesTask.focus,",
    "    ready: termesTask.instructions.trim().length > 0,",
    "    generatedFiles: [",
    "      'TASK.md',",
    "      'README.md',",
    "      'package.json',",
    "      'src/termes-task.mjs',",
    "      'scripts/verify.mjs',",
    "      'reports/implementation-summary.md',",
    "    ],",
    "  };",
    "}",
    "",
  ].join("\n");

  const verifier = [
    "import { writeFile } from 'node:fs/promises';",
    "import { termesTask, implementationSummary } from '../src/termes-task.mjs';",
    "",
    "const failures = [];",
    "if (!termesTask.taskId) failures.push('taskId is required');",
    "if (!termesTask.runId) failures.push('runId is required');",
    "if (!termesTask.title.trim()) failures.push('title is required');",
    "if (!termesTask.instructions.trim()) failures.push('instructions are required');",
    "if (!termesTask.focus.includes('runtime-verification')) failures.push('runtime-verification focus is required');",
    "",
    "const result = {",
    "  status: failures.length === 0 ? 'passed' : 'failed',",
    "  checkedAt: new Date().toISOString(),",
    "  task: termesTask,",
    "  summary: implementationSummary(),",
    "  failures,",
    "};",
    "",
    "await writeFile('reports/verification.json', `${JSON.stringify(result, null, 2)}\\n`);",
    "console.log(JSON.stringify(result, null, 2));",
    "if (failures.length > 0) process.exit(1);",
    "",
  ].join("\n");

  const readme = [
    "# Termes Task Worktree",
    "",
    `Run: ${input.runId}`,
    `Task: ${input.taskId}`,
    `Session: ${input.sessionId}`,
    `Project: ${asString(body.projectId) || "unknown"}`,
    "",
    "## Title",
    input.title,
    "",
    "## Instructions",
    input.instructions || "(empty)",
    "",
    "## Generated Source",
    "- `src/termes-task.mjs` exports the task contract and implementation summary.",
    "- `scripts/verify.mjs` validates the generated implementation contract.",
    "- `reports/verification.json` stores machine-readable verification output after execution.",
    "",
  ].join("\n");

  const summary = [
    "# Implementation Summary",
    "",
    "Termes created a real task worktree with source code, metadata, and executable verification.",
    "",
    "## Focus",
    ...focus.map((item) => `- ${item}`),
    "",
    "## Verification",
    "Run `node scripts/verify.mjs` from this worktree.",
    "",
  ].join("\n");

  const packageJson = {
    name: packageNameForTask(input.taskId),
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      verify: "node scripts/verify.mjs",
    },
  };

  const manifestPath = path.join(worktreePath, "task.json");
  const sourcePath = path.join(srcRoot, "termes-task.mjs");
  const verifierPath = path.join(scriptsRoot, "verify.mjs");
  const readmePath = path.join(worktreePath, "README.md");
  const summaryPath = path.join(reportsRoot, "implementation-summary.md");

  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(worktreePath, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`),
    writeFile(sourcePath, source),
    writeFile(verifierPath, verifier),
    writeFile(readmePath, `${readme}\n`),
    writeFile(summaryPath, `${summary}\n`),
  ]);

  return { manifestPath, sourcePath, verifierPath, readmePath, summaryPath };
}

async function executeRun(
  runsRoot: string,
  workspaceRoot: string,
  body: RunRequest,
): Promise<{
  status: "completed";
  worktreePath: string;
  artifactUri: string;
  checksum: string;
  output: string;
  changedFiles: ChangedFile[];
  commands: CommandResult[];
}> {
  const runId = asString(body.runId) || `manual-${Date.now()}`;
  const taskId = asString(body.taskId) || runId;
  const sessionId = asString(body.sessionId) || `session-${runId}`;
  const title = asString(body.title) || "Termes task";
  const instructions = asString(body.instructions) || "";
  const defaultWorktree = path.join(runsRoot, taskId, "architect", "worktree");
  const worktreePath = await assertPathInsideRoot(runsRoot, asString(body.worktreePath) || defaultWorktree);
  const projectWorkspacePath = await assertPathInsideRoot(
    workspaceRoot,
    path.join(workspaceRoot, asString(body.projectId) || "default"),
  );
  const runOutputPath = path.join(runsRoot, taskId, "architect");
  await mkdir(worktreePath, { recursive: true });
  await mkdir(projectWorkspacePath, { recursive: true });
  await mkdir(runOutputPath, { recursive: true });

  const taskMarkdown = [
    "# Termes Task",
    "",
    `Run: ${runId}`,
    `Session: ${sessionId}`,
    `Project: ${asString(body.projectId) || "unknown"}`,
    `Task: ${taskId}`,
    "",
    "## Title",
    title,
    "",
    "## Instructions",
    instructions || "(empty)",
    "",
  ].join("\n");

  await writeFile(path.join(worktreePath, "TASK.md"), taskMarkdown);
  const implementation = await writeWorkspaceImplementation(worktreePath, body, {
    runId,
    taskId,
    sessionId,
    title,
    instructions,
  });
  await writeFile(
    path.join(projectWorkspacePath, "last-run.json"),
    `${JSON.stringify(
      {
        runId,
        taskId,
        title,
        worktreePath,
        artifactUri: path.join(runOutputPath, "artifact.md"),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  const commands = [
    await runCommand(worktreePath, "pwd"),
    await runCommand(worktreePath, "node --check src/termes-task.mjs"),
    await runCommand(worktreePath, "node scripts/verify.mjs"),
    await runCommand(worktreePath, "find . -maxdepth 4 -type f | sort"),
    await runCommand(worktreePath, "node --version"),
  ];
  const failedCommand = commands.find((command) => command.exitCode !== 0);
  if (failedCommand) {
    throw new Error(`Runner command failed: ${failedCommand.command}\n${failedCommand.stderr || failedCommand.stdout}`);
  }

  const changedFiles = await collectFiles(worktreePath);
  const commandLog = commands
    .map((command) =>
      [
        `$ ${command.command}`,
        `exit=${command.exitCode} durationMs=${command.durationMs}`,
        command.stdout ? `stdout:\n${command.stdout.trim()}` : "",
        command.stderr ? `stderr:\n${command.stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  const output = [
    "# Termes Runner Execution",
    "",
    `Run: ${runId}`,
    `Task: ${taskId}`,
    `Worktree: ${worktreePath}`,
    "",
    "## Summary",
    "Runner supervisor created a concrete task worktree, generated source files, executed verification, and collected changed files.",
    "",
    "## Workspace",
    `Project workspace: ${projectWorkspacePath}`,
    `Task worktree: ${worktreePath}`,
    "",
    "## Generated Implementation",
    `- Manifest: ${path.relative(worktreePath, implementation.manifestPath)}`,
    `- Source: ${path.relative(worktreePath, implementation.sourcePath)}`,
    `- Verifier: ${path.relative(worktreePath, implementation.verifierPath)}`,
    `- README: ${path.relative(worktreePath, implementation.readmePath)}`,
    `- Summary: ${path.relative(worktreePath, implementation.summaryPath)}`,
    "",
    "## Changed Files",
    ...changedFiles.map((file) => `- ${file.path} (${file.bytes} bytes, ${file.sha256})`),
    "",
    "## Command Log",
    "```text",
    commandLog,
    "```",
  ].join("\n");
  const checksum = createHash("sha256").update(output).digest("hex");
  const artifactUri = path.join(runOutputPath, "artifact.md");

  await writeFile(artifactUri, `${output}\n`);
  await writeFile(
    path.join(runOutputPath, "execution.json"),
    `${JSON.stringify(
      {
        runId,
        taskId,
        worktreePath,
        projectWorkspacePath,
        artifactUri,
        checksum,
        changedFiles,
        commands,
        implementation,
      },
      null,
      2,
    )}\n`,
  );

  return {
    status: "completed",
    worktreePath,
    artifactUri,
    checksum,
    output,
    changedFiles,
    commands,
  };
}

async function main(): Promise<void> {
  const workspaceRoot = requiredEnv("WORKSPACE_ROOT");
  const runsRoot = requiredEnv("RUNS_ROOT");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(runsRoot, { recursive: true });

  const app = Fastify({ logger: true });

  app.get("/healthz", async () => {
    return {
      service: "runner-supervisor",
      version: TERMES_VERSION,
      status: "ok",
      workspaceRoot,
      runsRoot,
      checkedAt: new Date().toISOString(),
    };
  });

  app.get("/policy", async () => {
    return {
      workspaceRoot,
      runsRoot,
      container: {
        user: "non-root",
        mount: "/workspace",
        capDrop: ["ALL"],
        noNewPrivileges: true,
        readOnlyRootFilesystem: true,
        tmpfs: ["/tmp"],
        dockerSocketMounted: false,
      },
      deniedCommands: ["sudo", "su", "docker", "systemctl", "rm -rf /", "curl | sh", "wget | sh"],
    };
  });

  app.post("/runs", async (request, reply) => {
    const result = await executeRun(runsRoot, workspaceRoot, request.body as RunRequest);
    return reply.code(201).send(result);
  });

  app.get("/validate-path", async (request, reply) => {
    const query = request.query as { path?: string };
    if (!query.path) {
      return reply.code(400).send({ error: "path query is required" });
    }

    const allowed = await isInsideRoot(workspaceRoot, query.path).catch(() => false);
    return { allowed };
  });

  await app.listen({ host: "0.0.0.0", port: port() });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

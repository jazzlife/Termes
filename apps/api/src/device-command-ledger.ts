import { createHash } from "node:crypto";

const secretParamKeyPattern =
  /(password|passwd|passphrase|token|secret|clientsecret|client_secret|api[-_]?key|private[-_]?key|authorization|credential)/i;

function redactSecretParams(value: unknown, key = ""): unknown {
  if (secretParamKeyPattern.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactSecretParams(item));
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      redacted[childKey] = redactSecretParams(childValue, childKey);
    }
    return redacted;
  }
  return value;
}

export function deviceCommandParamsForLedger(
  action: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!action.endsWith(".dev.app.run")) {
    return redactSecretParams(params) as Record<string, unknown>;
  }
  const files = Array.isArray(params.files)
    ? params.files.map((value) => {
        const file = value && typeof value === "object" ? value as Record<string, unknown> : {};
        const content = typeof file.content === "string" ? file.content : "";
        return {
          path: typeof file.path === "string" ? file.path : "",
          bytes: Buffer.byteLength(content),
          sha256: createHash("sha256").update(content).digest("hex"),
        };
      })
    : [];
  return {
    appId: params.appId,
    runtime: params.runtime,
    entrypoint: params.entrypoint,
    argumentCount: Array.isArray(params.args) ? params.args.length : 0,
    timeoutMs: params.timeoutMs,
    files,
  };
}

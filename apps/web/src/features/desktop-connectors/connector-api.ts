import type {
  DesktopConnectorPairingCodeSummary,
  DesktopConnectorSummary,
} from "@termes/shared";

async function connectorRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error || `Desktop connector request failed: ${response.status}`);
  }
  return body;
}

export async function createDesktopConnectorPairingCode(
  projectId: string,
): Promise<DesktopConnectorPairingCodeSummary> {
  return connectorRequest<DesktopConnectorPairingCodeSummary>(
    "/api/desktop-connectors/pairing-codes",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    },
  );
}

export async function fetchDesktopConnectors(projectId: string): Promise<DesktopConnectorSummary[]> {
  const params = new URLSearchParams({ projectId });
  const body = await connectorRequest<{ connectors: DesktopConnectorSummary[] }>(
    `/api/desktop-connectors?${params.toString()}`,
  );
  return body.connectors;
}

export async function revokeDesktopConnector(connectorId: string): Promise<void> {
  await connectorRequest<Record<string, never>>(
    `/api/desktop-connectors/${encodeURIComponent(connectorId)}`,
    { method: "DELETE" },
  );
}

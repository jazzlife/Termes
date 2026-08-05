export type ConnectionPhase =
  | "unpaired"
  | "connecting"
  | "online"
  | "busy"
  | "offline"
  | "error";

export type PermissionValue = "granted" | "denied" | "not_determined" | "unsupported";

export interface PermissionState {
  accessibility: PermissionValue;
  screenCapture: PermissionValue;
  inputControl: PermissionValue;
  processInspection: PermissionValue;
}

export interface ConnectorSettings {
  apiBaseUrl: string;
  connectorId: string;
  deviceId: string;
  accountId: string;
  accountLoginId: string | null;
  accountEmail: string | null;
  workspaceId: string;
  workspaceKey: string;
  projectId: string;
  projectName: string;
  deviceName: string;
  platform: "windows" | "macos";
  autoObserve: boolean;
  autoControl: boolean;
  autoApprovalPolicyVersion: number;
}

export interface PendingApproval {
  commandId: string;
  sequence: number;
  action: string;
  params: unknown;
  requestedAt: string;
  deadline: string;
  readOnly: boolean;
}

export interface ActivityEntry {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail: string;
  success: boolean | null;
}

export interface ConnectorSnapshot {
  phase: ConnectionPhase;
  settings: ConnectorSettings | null;
  permissions: PermissionState;
  capabilities: string[];
  pendingApprovals: PendingApproval[];
  activities: ActivityEntry[];
  lastError: string | null;
}

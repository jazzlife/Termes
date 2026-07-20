import type { ExperienceKind } from "./experience";

export type ExperienceCapability =
  | "conversation"
  | "task-create"
  | "interaction-response"
  | "plan"
  | "specialist-summary"
  | "changes-summary"
  | "verification"
  | "source-review"
  | "diff-review"
  | "source-edit"
  | "terminal-interactive"
  | "device-control"
  | "runtime-operator"
  | "raw-json-rpc";

const EXPERIENCE_POLICY: Record<ExperienceKind, ReadonlySet<ExperienceCapability>> = {
  mobile: new Set([
    "conversation",
    "task-create",
    "interaction-response",
    "plan",
    "specialist-summary",
    "changes-summary",
    "verification",
  ]),
  tablet: new Set([
    "conversation",
    "task-create",
    "interaction-response",
    "plan",
    "specialist-summary",
    "changes-summary",
    "verification",
    "source-review",
    "diff-review",
  ]),
  desktop: new Set([
    "conversation",
    "task-create",
    "interaction-response",
    "plan",
    "specialist-summary",
    "changes-summary",
    "verification",
    "source-review",
    "diff-review",
    "source-edit",
    "terminal-interactive",
    "device-control",
    "runtime-operator",
    "raw-json-rpc",
  ]),
};

export interface CapabilityContext {
  experience: ExperienceKind;
  upstreamSupported: boolean;
  accountAllowed: boolean;
  contextAvailable: boolean;
}

export function experienceAllows(
  experience: ExperienceKind,
  capability: ExperienceCapability,
): boolean {
  return EXPERIENCE_POLICY[experience].has(capability);
}

export function resolveEffectiveCapability(
  capability: ExperienceCapability,
  context: CapabilityContext,
): boolean {
  return context.upstreamSupported
    && context.accountAllowed
    && context.contextAvailable
    && experienceAllows(context.experience, capability);
}

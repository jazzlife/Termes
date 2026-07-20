export const ROUTING_POLICY_VERSION = 10;

export type FastQuestionType =
  | "conversation"
  | "general-question"
  | "project-read"
  | "analysis"
  | "design"
  | "coding"
  | "operation"
  | "research"
  | "security"
  | "clarification"
  | "system-control";

export type RoutingContextType =
  | "current-turn"
  | "recent-conversation"
  | "system-context"
  | "project-state"
  | "external-context";

export type RoutingScreeningDecision = {
  questionType: FastQuestionType;
  contextType: RoutingContextType;
  domain: QuestionDomain;
  professionalRequired: boolean;
  answer: string | null;
};

export type QuestionDomain =
  | "software"
  | "security"
  | "operations"
  | "data"
  | "research"
  | "product"
  | "general";

export type RouteIntent =
  | "conversation"
  | "question"
  | "analysis"
  | "implementation"
  | "operation"
  | "destructive"
  | "control";

export type ExecutionRoute =
  | "system-control"
  | "instant"
  | "direct"
  | "single-specialist"
  | "parallel-specialists"
  | "critical-synthesis"
  | "clarification";

export type EvidenceRequirement = "none" | "context" | "tool" | "independent-review";
export type QuestionWeight = "light" | "standard" | "heavy" | "critical";
export type CollaborationMode = "direct" | "parallel-review" | "parallel-synthesis";
export type SpecialistToolset = "file" | "terminal" | "web" | "browser";
export type CapabilityKey =
  | "github-project-bootstrap"
  | "runner-worktree-verification"
  | "web-pwa-verification"
  | "linux-ssh-ops"
  | "windows-powershell-ops"
  | "android-adb-debug"
  | "tizen-sdb-debug"
  | "local-mock-device";
export type RiskSignal =
  | "destructive-change"
  | "auth-or-secret"
  | "production-or-deploy"
  | "security-impact"
  | "multi-account-isolation"
  | "external-device";

export type SemanticAction =
  | "converse"
  | "read"
  | "analyze"
  | "implement"
  | "operate"
  | "delete"
  | "control"
  | "clarify";

export type SemanticTarget =
  | "project.identity"
  | "workspace.identity"
  | "system.status"
  | "code"
  | "runtime"
  | "data"
  | "security"
  | "product"
  | "research"
  | "general"
  | "unknown";

export type SemanticFrame = {
  action: SemanticAction;
  target: SemanticTarget;
  scope: "current-turn" | "recent-summary" | "project-state" | "system-context";
  requiresMutation: boolean;
  requiresInspection: boolean;
  primaryDomain: QuestionDomain;
  secondaryDomains: QuestionDomain[];
  riskSignals: RiskSignal[];
  reasonCodes: string[];
};

export type RoutingAgentSpecialist = {
  domain: QuestionDomain;
  role: string;
  mission: string;
  toolsets: SpecialistToolset[];
  required: boolean;
};

export type RoutingAgentPlan = {
  weight: QuestionWeight;
  collaboration: CollaborationMode;
  specialists: RoutingAgentSpecialist[];
  requireEvidence: boolean;
  requireIndependentReview: boolean;
};

export type RouteDecision = {
  version: typeof ROUTING_POLICY_VERSION;
  intent: RouteIntent;
  route: ExecutionRoute;
  primaryDomain: QuestionDomain;
  secondaryDomains: QuestionDomain[];
  riskSignals: RiskSignal[];
  evidenceRequirement: EvidenceRequirement;
  contextRequirement: "current-turn" | "recent-summary" | "project-state";
  reasonCodes: string[];
  source: "routing-specialist";
  semanticFrame: SemanticFrame;
  agentPlan: RoutingAgentPlan;
  selectedCapabilities: CapabilityKey[];
  directAnswer?: string;
};

export type RoutingSystemContext = {
  projectId: string;
  projectName: string;
  projectKey: string;
  projectPath: string;
  workspaceId: string;
  workspaceKey: string;
};

const DOMAINS = new Set<QuestionDomain>(["software", "security", "operations", "data", "research", "product", "general"]);
const INTENTS = new Set<RouteIntent>(["conversation", "question", "analysis", "implementation", "operation", "destructive", "control"]);
const ROUTES = new Set<ExecutionRoute>(["system-control", "instant", "direct", "single-specialist", "parallel-specialists", "critical-synthesis", "clarification"]);
const CONTEXTS = new Set<RouteDecision["contextRequirement"]>(["current-turn", "recent-summary", "project-state"]);
const ACTIONS = new Set<SemanticAction>(["converse", "read", "analyze", "implement", "operate", "delete", "control", "clarify"]);
const TARGETS = new Set<SemanticTarget>(["project.identity", "workspace.identity", "system.status", "code", "runtime", "data", "security", "product", "research", "general", "unknown"]);
const SCOPES = new Set<SemanticFrame["scope"]>(["current-turn", "recent-summary", "project-state", "system-context"]);
const RISKS = new Set<RiskSignal>(["destructive-change", "auth-or-secret", "production-or-deploy", "security-impact", "multi-account-isolation", "external-device"]);
const TOOLSETS = new Set<SpecialistToolset>(["file", "terminal", "web", "browser"]);
const CAPABILITIES = new Set<CapabilityKey>([
  "github-project-bootstrap", "runner-worktree-verification", "web-pwa-verification", "linux-ssh-ops",
  "windows-powershell-ops", "android-adb-debug", "tizen-sdb-debug", "local-mock-device",
]);
const FAST_QUESTION_TYPES = new Set<FastQuestionType>([
  "conversation", "general-question", "project-read", "analysis", "design", "coding", "operation",
  "research", "security", "clarification", "system-control",
]);
const ROUTING_CONTEXT_TYPES = new Set<RoutingContextType>([
  "current-turn", "recent-conversation", "system-context", "project-state", "external-context",
]);
const DIRECT_ROUTES = new Set<ExecutionRoute>(["system-control", "instant", "direct", "clarification"]);
const CRITICAL_RISKS = new Set<RiskSignal>(["destructive-change", "auth-or-secret", "production-or-deploy", "security-impact", "multi-account-isolation"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Routing Agent returned invalid ${label}`);
  return value as Record<string, unknown>;
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>, label: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) throw new Error(`Routing Agent returned invalid ${label}`);
  return value as T;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Routing Agent returned invalid ${label}`);
  return value;
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`Routing Agent returned invalid ${label}`);
  }
  return value.trim();
}

function enumArray<T extends string>(value: unknown, allowed: Set<T>, label: string, maxItems: number): T[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Routing Agent returned invalid ${label}`);
  const parsed = value.map((entry) => enumValue(entry, allowed, label));
  if (new Set(parsed).size !== parsed.length) throw new Error(`Routing Agent returned duplicate ${label}`);
  return parsed;
}

function textArray(value: unknown, label: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Routing Agent returned invalid ${label}`);
  const parsed = value.map((entry) => boundedText(entry, label, 120));
  if (new Set(parsed).size !== parsed.length) throw new Error(`Routing Agent returned duplicate ${label}`);
  return parsed;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw new Error(`Routing Agent returned unknown ${label} fields: ${unknown.join(",")}`);
}

export function parseRoutingScreeningDecision(text: string): RoutingScreeningDecision {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Fast Routing Agent returned no JSON object");
  const value = record(JSON.parse(text.slice(start, end + 1)), "screening decision");
  exactKeys(value, ["questionType", "contextType", "domain", "professionalRequired", "answer"], "screening decision");
  const questionType = enumValue(value.questionType, FAST_QUESTION_TYPES, "questionType");
  const contextType = enumValue(value.contextType, ROUTING_CONTEXT_TYPES, "contextType");
  const domain = enumValue(value.domain, DOMAINS, "domain");
  const professionalRequired = booleanValue(value.professionalRequired, "professionalRequired");
  const answer = value.answer == null ? null : boundedText(value.answer, "answer", 10_000);
  if (professionalRequired !== (answer === null)) {
    throw new Error("Fast Routing Agent professional decisions require answer=null and direct decisions require an answer");
  }
  return { questionType, contextType, domain, professionalRequired, answer };
}

export function routeDecisionFromScreening(screening: RoutingScreeningDecision): RouteDecision {
  if (screening.professionalRequired || !screening.answer) {
    throw new Error("Professional screening decisions require Agent planning");
  }
  const isConversation = screening.questionType === "conversation";
  const isClarification = screening.questionType === "clarification";
  const isSystemControl = screening.questionType === "system-control";
  const route: ExecutionRoute = isConversation ? "instant" : isClarification ? "clarification" : isSystemControl ? "system-control" : "direct";
  const intent: RouteIntent = isConversation ? "conversation" : isSystemControl ? "control" : "question";
  const action: SemanticAction = isConversation ? "converse" : isClarification ? "clarify" : isSystemControl ? "control" : "read";
  const target: SemanticTarget = isSystemControl
    ? "runtime"
    : screening.contextType === "system-context"
      ? "project.identity"
      : "general";
  const scope: SemanticFrame["scope"] = screening.contextType === "recent-conversation"
    ? "recent-summary"
    : screening.contextType === "system-context"
      ? "system-context"
      : screening.contextType === "project-state"
        ? "project-state"
        : "current-turn";
  const contextRequirement: RouteDecision["contextRequirement"] = screening.contextType === "recent-conversation"
    ? "recent-summary"
    : screening.contextType === "project-state"
      ? "project-state"
      : "current-turn";
  const reasonCodes = [`fast-agent-${screening.questionType}`, `context-${screening.contextType}`];
  return {
    version: ROUTING_POLICY_VERSION,
    intent,
    route,
    primaryDomain: screening.domain,
    secondaryDomains: [],
    riskSignals: [],
    evidenceRequirement: route === "direct" ? "context" : "none",
    contextRequirement,
    reasonCodes,
    source: "routing-specialist",
    semanticFrame: {
      action,
      target,
      scope,
      requiresMutation: false,
      requiresInspection: false,
      primaryDomain: screening.domain,
      secondaryDomains: [],
      riskSignals: [],
      reasonCodes,
    },
    agentPlan: {
      weight: "light",
      collaboration: "direct",
      specialists: [],
      requireEvidence: false,
      requireIndependentReview: false,
    },
    selectedCapabilities: [],
    directAnswer: screening.answer,
  };
}

function parseSpecialists(value: unknown): RoutingAgentSpecialist[] {
  if (!Array.isArray(value) || value.length > 5) {
    throw new Error("Routing Agent returned invalid specialists");
  }
  const specialists = value.map((entry, index) => {
    const specialist = record(entry, `specialists[${index}]`);
    exactKeys(specialist, ["domain", "role", "mission", "toolsets", "required"], `specialists[${index}]`);
    return {
      domain: enumValue(specialist.domain, DOMAINS, `specialists[${index}].domain`),
      role: boundedText(specialist.role, `specialists[${index}].role`, 100),
      mission: boundedText(specialist.mission, `specialists[${index}].mission`, 500),
      toolsets: enumArray(specialist.toolsets, TOOLSETS, `specialists[${index}].toolsets`, 4),
      required: booleanValue(specialist.required, `specialists[${index}].required`),
    };
  });
  if (specialists.some((specialist) => !specialist.required)) {
    throw new Error("Routing Agent specialists must all be required");
  }
  return specialists;
}

function executionContract(route: ExecutionRoute, specialists: RoutingAgentSpecialist[]): {
  evidenceRequirement: EvidenceRequirement;
  agentPlan: RoutingAgentPlan;
} {
  const count = specialists.length;
  if (DIRECT_ROUTES.has(route) && count !== 0) throw new Error("Routing Agent assigned specialists to a direct route");
  if (route === "single-specialist" && count !== 1) throw new Error("Routing Agent single-specialist route requires exactly one specialist");
  if (route === "parallel-specialists" && (count < 2 || count > 4)) throw new Error("Routing Agent parallel-specialists route requires two to four specialists");
  if (route === "critical-synthesis" && (count < 3 || count > 5)) throw new Error("Routing Agent critical-synthesis route requires three to five specialists");

  if (route === "critical-synthesis") {
    return {
      evidenceRequirement: "independent-review",
      agentPlan: { weight: "critical", collaboration: "parallel-synthesis", specialists, requireEvidence: true, requireIndependentReview: true },
    };
  }
  if (route === "parallel-specialists") {
    return {
      evidenceRequirement: "tool",
      agentPlan: { weight: "heavy", collaboration: "parallel-review", specialists, requireEvidence: true, requireIndependentReview: true },
    };
  }
  if (route === "single-specialist") {
    return {
      evidenceRequirement: "tool",
      agentPlan: { weight: "standard", collaboration: "parallel-review", specialists, requireEvidence: true, requireIndependentReview: false },
    };
  }
  return {
    evidenceRequirement: route === "direct" ? "context" : "none",
    agentPlan: { weight: "light", collaboration: "direct", specialists, requireEvidence: false, requireIndependentReview: false },
  };
}

export function parseAgentRouteDecision(text: string): RouteDecision {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Routing Agent returned no JSON object");
  const value = record(JSON.parse(text.slice(start, end + 1)), "decision");
  exactKeys(value, [
    "intent", "route", "primaryDomain", "secondaryDomains", "riskSignals", "contextRequirement",
    "action", "target", "scope", "requiresMutation", "requiresInspection", "reasonCodes", "specialists", "capabilities", "directAnswer",
  ], "decision");
  const route = enumValue(value.route, ROUTES, "route");
  const primaryDomain = enumValue(value.primaryDomain, DOMAINS, "primaryDomain");
  const secondaryDomains = enumArray(value.secondaryDomains, DOMAINS, "secondaryDomains", 3);
  const riskSignals = enumArray(value.riskSignals, RISKS, "riskSignals", 6);
  const reasonCodes = textArray(value.reasonCodes, "reasonCodes", 12);
  const specialists = parseSpecialists(value.specialists);
  const contract = executionContract(route, specialists);
  const selectedCapabilities = enumArray(value.capabilities, CAPABILITIES, "capabilities", 8);
  const directAnswer = value.directAnswer == null ? undefined : boundedText(value.directAnswer, "directAnswer", 10_000);
  const semanticFrame: SemanticFrame = {
    action: enumValue(value.action, ACTIONS, "action"),
    target: enumValue(value.target, TARGETS, "target"),
    scope: enumValue(value.scope, SCOPES, "scope"),
    requiresMutation: booleanValue(value.requiresMutation, "requiresMutation"),
    requiresInspection: booleanValue(value.requiresInspection, "requiresInspection"),
    primaryDomain,
    secondaryDomains,
    riskSignals,
    reasonCodes,
  };
  const decision: RouteDecision = {
    version: ROUTING_POLICY_VERSION,
    intent: enumValue(value.intent, INTENTS, "intent"),
    route,
    primaryDomain,
    secondaryDomains,
    riskSignals,
    evidenceRequirement: contract.evidenceRequirement,
    contextRequirement: enumValue(value.contextRequirement, CONTEXTS, "contextRequirement"),
    reasonCodes,
    source: "routing-specialist",
    semanticFrame,
    agentPlan: contract.agentPlan,
    selectedCapabilities,
    ...(directAnswer ? { directAnswer } : {}),
  };

  if (DIRECT_ROUTES.has(decision.route) !== Boolean(decision.directAnswer)) {
    throw new Error("Routing Agent direct routes require a directAnswer and execution routes forbid one");
  }
  if (semanticFrame.requiresMutation && DIRECT_ROUTES.has(decision.route)) {
    throw new Error("Routing Agent attempted to place a mutation on a direct route");
  }
  if (DIRECT_ROUTES.has(decision.route) && selectedCapabilities.length > 0) {
    throw new Error("Routing Agent assigned capabilities to a direct route");
  }
  if (!DIRECT_ROUTES.has(decision.route) && !selectedCapabilities.includes("runner-worktree-verification")) {
    throw new Error("Routing Agent execution route requires runner-worktree-verification");
  }
  if (semanticFrame.requiresMutation
    && decision.riskSignals.some((signal) => CRITICAL_RISKS.has(signal))
    && decision.route !== "critical-synthesis") {
    throw new Error("Routing Agent high-risk mutation must use critical-synthesis");
  }
  return decision;
}

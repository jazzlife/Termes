import {
  type ExecutionRoute,
  type QuestionDomain,
  type QuestionWeight,
  type RouteDecision,
} from "./routing-policy";

export type { ExecutionRoute, QuestionDomain, RouteDecision } from "./routing-policy";
export type { QuestionWeight } from "./routing-policy";

export type SpecialistAssignment = {
  id: string;
  role: string;
  mission: string;
  toolsets: string[];
  required: boolean;
};

export type SpecialistBlueprint = {
  version: 2;
  route: ExecutionRoute;
  domain: QuestionDomain;
  secondaryDomains: QuestionDomain[];
  weight: QuestionWeight;
  riskSignals: string[];
  collaboration: "direct" | "parallel-review" | "parallel-synthesis";
  specialists: SpecialistAssignment[];
  requireEvidence: boolean;
  requireIndependentReview: boolean;
};

export function buildSpecialistBlueprint(decision: RouteDecision): SpecialistBlueprint {
  const specialists = decision.agentPlan.specialists.map((specialist, index) => ({
    id: `routing-agent-${index + 1}-${specialist.domain}`,
    role: specialist.role,
    mission: specialist.mission,
    toolsets: specialist.toolsets,
    required: specialist.required,
  }));
  return {
    version: 2,
    route: decision.route,
    domain: decision.primaryDomain,
    secondaryDomains: decision.secondaryDomains,
    weight: decision.agentPlan.weight,
    riskSignals: decision.riskSignals,
    collaboration: decision.agentPlan.collaboration,
    specialists,
    requireEvidence: decision.agentPlan.requireEvidence,
    requireIndependentReview: decision.agentPlan.requireIndependentReview,
  };
}

export function coordinatorInstructions(blueprint: SpecialistBlueprint, sharedContext = ""): string {
  if (blueprint.specialists.length === 0) {
    return [
      "You are the Termes direct response agent running on Hermes.",
      "Do not call delegate_task and do not use project tools.",
      "Answer the current user request directly, accurately, concisely, and in Korean.",
      sharedContext,
    ].filter(Boolean).join("\n");
  }
  const tasks = blueprint.specialists.map((specialist) => ({
    goal: `[${specialist.role}] ${specialist.mission}`,
    context: ["현재 사용자 요청과 프로젝트를 직접 확인하고 결론·근거·검증 결과를 한국어로 반환한다.", sharedContext].filter(Boolean).join("\n\n"),
    toolsets: specialist.toolsets,
    role: "leaf",
  }));
  return [
    "You are the Termes Coordinator running on Hermes.",
    `Classification: route=${blueprint.route}, domain=${blueprint.domain}, secondary=${blueprint.secondaryDomains.join(",") || "none"}, weight=${blueprint.weight}.`,
    `Risk signals: ${blueprint.riskSignals.join(",") || "none"}.`,
    "Use the Hermes delegate_task tool in batch mode exactly once with the JSON task specification below.",
    "Wait for every required specialist result. Do not replace a missing result with an assumption.",
    "Every specialist must remain inside the exclusive project workspace supplied in its context. Never use /opt/hermes, /opt/data, ~/.hermes, or Hermes internal Kanban as project evidence or a work target.",
    "Resolve conflicts using code or execution evidence and produce one concise final answer in Korean.",
    blueprint.requireIndependentReview ? "Explicitly address the independent criticism before finalizing." : "Cross-check the result before answering.",
    "Do not claim completion without concrete file, test, runtime, or primary-source evidence.",
    `delegate_task tasks=${JSON.stringify(tasks)}`,
  ].join("\n");
}

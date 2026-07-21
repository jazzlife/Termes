import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAgentRouteDecision,
  parseRoutingScreeningDecision,
  routeDecisionFromScreening,
} from "../../services/orchestrator/src/routing-policy.ts";
import { buildSpecialistBlueprint, coordinatorInstructions } from "../../services/orchestrator/src/specialist-blueprint.ts";

function directDecision(overrides: Record<string, unknown> = {}) {
  const reasonCodes = ["routing-agent-direct"];
  return {
    intent: "question",
    route: "direct",
    primaryDomain: "general",
    secondaryDomains: [],
    riskSignals: [],
    contextRequirement: "current-turn",
    action: "read",
    target: "general",
    scope: "current-turn",
    requiresMutation: false,
    requiresInspection: false,
    reasonCodes,
    specialists: [],
    capabilities: [],
    directAnswer: "Routing Agent가 생성한 직접 답변입니다.",
    ...overrides,
  };
}

function specialist(domain: string, role: string, mission: string, toolsets = ["file", "terminal"]) {
  return { domain, role, mission, toolsets, required: true };
}

function executionDecision(input: {
  route: "single-specialist" | "parallel-specialists" | "critical-synthesis";
  primaryDomain: string;
  secondaryDomains?: string[];
  riskSignals?: string[];
  specialists: Array<Record<string, unknown>>;
  capabilities?: string[];
}) {
  const secondaryDomains = input.secondaryDomains || [];
  const riskSignals = input.riskSignals || [];
  const reasonCodes = ["routing-agent-execution"];
  return {
    intent: "implementation",
    route: input.route,
    primaryDomain: input.primaryDomain,
    secondaryDomains,
    riskSignals,
    contextRequirement: "project-state",
    action: "implement",
    target: input.primaryDomain === "security" ? "security" : "code",
    scope: "project-state",
    requiresMutation: true,
    requiresInspection: true,
    reasonCodes,
    specialists: input.specialists,
    capabilities: input.capabilities || ["runner-worktree-verification"],
    directAnswer: null,
  };
}

test("첫 Agent 응답은 컨텍스트 분류를 중심으로 하고 일반 응답일 때만 답변을 포함한다", () => {
  const general = parseRoutingScreeningDecision(JSON.stringify({
    questionType: "general-question",
    contextType: "system-context",
    domain: "general",
    professionalRequired: false,
    answer: "현재 프로젝트는 Termes입니다.",
  }));
  const direct = routeDecisionFromScreening(general);
  assert.equal(direct.route, "direct");
  assert.equal(direct.directAnswer, "현재 프로젝트는 Termes입니다.");
  assert.equal(direct.semanticFrame.scope, "system-context");

  const professional = parseRoutingScreeningDecision(JSON.stringify({
    questionType: "coding",
    contextType: "project-state",
    domain: "software",
    professionalRequired: true,
    answer: null,
  }));
  assert.equal(professional.answer, null);
  assert.throws(() => routeDecisionFromScreening(professional), /require Agent planning/);
  assert.throws(
    () => parseRoutingScreeningDecision(JSON.stringify({ ...professional, answer: "미리 만든 답변" })),
    /require answer=null/,
  );
});

test("단순 대화와 직접 답변도 내부 정규식이 아니라 Routing Agent 결정으로 처리한다", () => {
  const raw = directDecision({
    intent: "conversation",
    route: "instant",
    directAnswer: "네, 정상적으로 응답하고 있습니다. 무엇을 도와드릴까요?",
    action: "converse", target: "general", scope: "current-turn",
    requiresMutation: false, requiresInspection: false,
    reasonCodes: ["response-check"],
  });
  const decision = parseAgentRouteDecision(JSON.stringify(raw));
  const blueprint = buildSpecialistBlueprint(decision);
  assert.equal(decision.source, "routing-specialist");
  assert.equal(decision.route, "instant");
  assert.equal(blueprint.specialists.length, 0);
  assert.doesNotMatch(coordinatorInstructions(blueprint), /delegate_task tasks=/);
});

test("현재 프로젝트 메타데이터 답변도 Agent가 system context를 해석해 직접 반환한다", () => {
  const decision = parseAgentRouteDecision(JSON.stringify(directDecision({
    reasonCodes: ["system-context-identity"],
    action: "read", target: "project.identity", scope: "system-context",
    requiresMutation: false, requiresInspection: false,
    directAnswer: "현재 프로젝트는 Termes이며 경로는 /workspace/projects/termes입니다.",
  })));
  assert.equal(decision.semanticFrame.target, "project.identity");
  assert.equal(buildSpecialistBlueprint(decision).specialists.length, 0);
});

test("허용되지 않은 Agent enum과 구형 중복 필드는 실행 전에 거부한다", () => {
  assert.throws(
    () => parseAgentRouteDecision(JSON.stringify(directDecision({ primaryDomain: "security-infrastructure" }))),
    /invalid primaryDomain/,
  );
  assert.throws(
    () => parseAgentRouteDecision(JSON.stringify(directDecision({ semanticFrame: {} }))),
    /unknown decision fields/,
  );
});

test("Agent가 mutation을 direct로 내리거나 직접 경로에 전문가를 붙이면 거부한다", () => {
  const mutation = directDecision({
    action: "implement", target: "code", scope: "project-state",
    requiresMutation: true, requiresInspection: true,
    reasonCodes: ["bad-direct-mutation"],
  });
  assert.throws(() => parseAgentRouteDecision(JSON.stringify(mutation)), /mutation on a direct route/);

  const withSpecialist = directDecision();
  (withSpecialist.specialists as unknown[]) = [specialist("software", "Software Specialist", "코드를 검증한다.")];
  assert.throws(() => parseAgentRouteDecision(JSON.stringify(withSpecialist)), /assigned specialists to a direct route/);
});

test("실행 capability도 내부 키워드가 아니라 Agent 선택을 그대로 검증해 사용한다", () => {
  const decision = parseAgentRouteDecision(JSON.stringify(executionDecision({
    route: "single-specialist",
    primaryDomain: "product",
    specialists: [specialist("product", "Mobile UI Specialist", "모바일 UI를 구현하고 실제 viewport를 검증한다.", ["file", "browser"])],
    capabilities: ["runner-worktree-verification", "web-pwa-verification"],
  })));
  assert.deepEqual(decision.selectedCapabilities, ["runner-worktree-verification", "web-pwa-verification"]);
  assert.throws(
    () => parseAgentRouteDecision(JSON.stringify(executionDecision({
      route: "single-specialist",
      primaryDomain: "software",
      specialists: [specialist("software", "Software Specialist", "코드를 구현한다.")],
      capabilities: ["unknown-capability"],
    }))),
    /invalid capabilities/,
  );
  assert.throws(
    () => parseAgentRouteDecision(JSON.stringify(executionDecision({
      route: "single-specialist",
      primaryDomain: "software",
      specialists: [specialist("software", "Software Specialist", "코드를 구현한다.")],
      capabilities: [],
    }))),
    /requires runner-worktree-verification/,
  );
});

test("단일 구현 경로는 Agent가 선택한 역할·임무·도구를 그대로 Blueprint로 사용한다", () => {
  const decision = parseAgentRouteDecision(JSON.stringify(executionDecision({
    route: "single-specialist",
    primaryDomain: "software",
    specialists: [specialist("software", "TypeScript Reliability Specialist", "현재 코드 수정과 회귀 테스트를 완수한다.")],
  })));
  const blueprint = buildSpecialistBlueprint(decision);
  assert.equal(blueprint.specialists.length, 1);
  assert.equal(blueprint.specialists[0]?.role, "TypeScript Reliability Specialist");
  assert.equal(blueprint.specialists[0]?.mission, "현재 코드 수정과 회귀 테스트를 완수한다.");
  assert.deepEqual(blueprint.specialists[0]?.toolsets, ["file", "terminal"]);
});

test("다중 도메인 경로의 전문가 구성과 독립 검토 여부는 Agent 계획을 따른다", () => {
  const decision = parseAgentRouteDecision(JSON.stringify(executionDecision({
    route: "parallel-specialists",
    primaryDomain: "product",
    secondaryDomains: ["software"],
    specialists: [
      specialist("product", "Mobile Product Specialist", "모바일 경험과 사용자 흐름을 검증한다.", ["file", "browser"]),
      specialist("software", "API Integration Specialist", "API 연결과 상태 정합성을 구현한다."),
      specialist("general", "Independent Reviewer", "두 결과의 충돌과 누락을 독립 검토한다."),
    ],
  })));
  const blueprint = buildSpecialistBlueprint(decision);
  assert.equal(blueprint.specialists.length, 3);
  assert.equal(blueprint.requireIndependentReview, true);
  assert.deepEqual(blueprint.specialists.map((entry) => entry.role), [
    "Mobile Product Specialist", "API Integration Specialist", "Independent Reviewer",
  ]);
});

test("Hermes 동시 위임 한도를 초과하는 전문가 계획은 실행 전에 거부한다", () => {
  const decision = executionDecision({
    route: "parallel-specialists",
    primaryDomain: "software",
    specialists: [
      specialist("software", "Implementation Specialist", "구현을 검증한다."),
      specialist("product", "Product Specialist", "제품 흐름을 검증한다."),
      specialist("security", "Security Specialist", "보안 영향을 검증한다."),
      specialist("general", "Independent Reviewer", "독립 검토를 수행한다."),
    ],
  });
  assert.throws(
    () => parseAgentRouteDecision(JSON.stringify(decision)),
    /at most 3 concurrent specialists/,
  );
});

test("고위험 변경을 critical보다 낮춘 Agent 출력은 내부 재분류 없이 안전 불변식으로 거부한다", () => {
  const lowered = executionDecision({
    route: "single-specialist",
    primaryDomain: "security",
    riskSignals: ["auth-or-secret", "production-or-deploy", "multi-account-isolation"],
    specialists: [specialist("security", "Security Specialist", "인증 격리를 구현한다.")],
  });
  assert.throws(() => parseAgentRouteDecision(JSON.stringify(lowered)), /high-risk mutation must use critical-synthesis/);
});

test("critical 경로는 Hermes 한도 내의 전문팀을 Coordinator 계약으로 전달한다", () => {
  const decision = parseAgentRouteDecision(JSON.stringify(executionDecision({
    route: "critical-synthesis",
    primaryDomain: "security",
    secondaryDomains: ["operations", "software"],
    riskSignals: ["auth-or-secret", "production-or-deploy", "multi-account-isolation"],
    specialists: [
      specialist("security", "OAuth Isolation Specialist", "계정 인증 경계를 구현하고 검증한다."),
      specialist("general", "Independent Critic", "설계의 반례와 누락을 독립 검토한다."),
      specialist("software", "Evidence Verifier", "코드·테스트·배포 증거를 재현한다."),
    ],
  })));
  const blueprint = buildSpecialistBlueprint(decision);
  const prompt = coordinatorInstructions(blueprint);
  assert.equal(blueprint.specialists.length, 3);
  assert.match(prompt, /delegate_task tool in batch mode exactly once/);
  assert.match(prompt, /OAuth Isolation Specialist/);
  assert.match(prompt, /Evidence Verifier/);
  assert.match(prompt, /"role":"leaf"/);
});

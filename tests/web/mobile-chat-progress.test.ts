import assert from "node:assert/strict";
import test from "node:test";

import { buildMobileChatProgress } from "../../apps/web/src/experiences/mobile/chat-progress.ts";

test("메시지 전송 직후 Hermes 응답 준비 상태를 즉시 보여준다", () => {
  const progress = buildMobileChatProgress({
    sendingMessage: true,
    projection: null,
    turn: null,
    orchestration: null,
  });

  assert.equal(progress.visible, true);
  assert.equal(progress.active, true);
  assert.equal(progress.label, "Hermes에 요청 전달 중");
  assert.deepEqual(progress.rows, [
    {
      id: "request",
      kind: "request",
      label: "요청 전달",
      detail: "Hermes가 작업을 시작할 수 있도록 준비하고 있습니다.",
      state: "running",
    },
  ]);
});

test("Routing 중에는 요청 완료와 처리 경로 결정을 단계별로 보여준다", () => {
  const progress = buildMobileChatProgress({
    sendingMessage: false,
    projection: null,
    turn: {
      id: "turn-1",
      taskId: "task-1",
      userMessageId: "message-1",
      status: "routing",
      failureCode: null,
      createdAt: "2026-07-20T00:00:00.000Z",
      completedAt: null,
      decision: null,
    },
    orchestration: null,
  });

  assert.equal(progress.active, true);
  assert.equal(progress.label, "처리 경로를 결정하는 중");
  assert.deepEqual(progress.rows.map((row) => [row.id, row.state]), [
    ["request", "completed"],
    ["routing", "running"],
  ]);
});

test("실행 중인 도구를 사람이 이해할 수 있는 현재 작업으로 보여준다", () => {
  const progress = buildMobileChatProgress({
    sendingMessage: false,
    projection: {
      sessionId: "session-1",
      pending: true,
      busy: true,
      needsInput: false,
      interaction: null,
      error: null,
      updatedAt: "2026-07-20T00:00:01.000Z",
      parts: [
        {
          type: "tool-call",
          toolCallId: "read-1",
          toolName: "read_file",
          args: { path: "apps/web/src/main.tsx" },
        },
      ],
    },
    turn: {
      id: "turn-1",
      taskId: "task-1",
      userMessageId: "message-1",
      status: "running",
      failureCode: null,
      createdAt: "2026-07-20T00:00:00.000Z",
      completedAt: null,
      decision: null,
    },
    orchestration: null,
  });

  assert.equal(progress.label, "파일을 확인하는 중");
  assert.deepEqual(progress.rows.map((row) => [row.id, row.label, row.state]), [
    ["request", "요청 전달", "completed"],
    ["routing", "처리 경로 결정", "completed"],
    ["tool:read-1", "파일 확인", "running"],
    ["response", "응답 작성", "pending"],
  ]);
  assert.equal(progress.rows[2]?.detail, "apps/web/src/main.tsx");
});

test("전문 에이전트 협업은 각 에이전트의 완료와 실행 상태를 함께 보고한다", () => {
  const progress = buildMobileChatProgress({
    sendingMessage: false,
    projection: {
      sessionId: "session-1",
      pending: true,
      busy: true,
      needsInput: false,
      interaction: null,
      error: null,
      updatedAt: "2026-07-20T00:00:02.000Z",
      parts: [],
    },
    turn: {
      id: "turn-1",
      taskId: "task-1",
      userMessageId: "message-1",
      status: "running",
      failureCode: null,
      createdAt: "2026-07-20T00:00:00.000Z",
      completedAt: null,
      decision: null,
    },
    orchestration: {
      id: "orchestration-1",
      domain: "software",
      secondaryDomains: [],
      weight: "standard",
      riskSignals: [],
      collaboration: "parallel-synthesis",
      requireEvidence: true,
      requireIndependentReview: false,
      status: "delegating",
      specialists: [
        {
          id: "specialist-1",
          key: "frontend",
          role: "Frontend Specialist",
          mission: "채팅 UI를 구현합니다.",
          toolsets: ["file"],
          required: true,
          status: "completed",
          hermesSubagentId: "child-1",
          resultSummary: "구현 완료",
        },
        {
          id: "specialist-2",
          key: "review",
          role: "Review Specialist",
          mission: "동작을 검증합니다.",
          toolsets: ["file", "terminal"],
          required: true,
          status: "running",
          hermesSubagentId: "child-2",
          resultSummary: null,
        },
      ],
    },
  });

  assert.equal(progress.label, "전문 에이전트 1명이 작업 중");
  assert.deepEqual(
    progress.rows.filter((row) => row.kind === "specialist").map((row) => [row.label, row.state]),
    [["Frontend Specialist", "completed"], ["Review Specialist", "running"]],
  );
});

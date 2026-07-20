import type {
  HermesSessionProjectionSummary,
  OrchestrationBlueprintSummary,
  TaskTurnSummary,
} from "@termes/shared";

export type MobileChatProgressRowState = "pending" | "running" | "completed" | "waiting" | "failed";
export type MobileChatProgressRowKind = "request" | "routing" | "tool" | "specialist" | "response";

export interface MobileChatProgressRow {
  id: string;
  kind: MobileChatProgressRowKind;
  label: string;
  detail: string;
  state: MobileChatProgressRowState;
}

export interface MobileChatProgressModel {
  visible: boolean;
  active: boolean;
  label: string;
  rows: MobileChatProgressRow[];
}

export interface MobileChatProgressInput {
  sendingMessage: boolean;
  projection: HermesSessionProjectionSummary | null;
  turn: TaskTurnSummary | null;
  orchestration: OrchestrationBlueprintSummary | null;
}

function requestRow(state: MobileChatProgressRowState): MobileChatProgressRow {
  return {
    id: "request",
    kind: "request",
    label: "요청 전달",
    detail: state === "running"
      ? "Hermes가 작업을 시작할 수 있도록 준비하고 있습니다."
      : "Hermes가 요청을 받았습니다.",
    state,
  };
}

function routingRow(state: MobileChatProgressRowState): MobileChatProgressRow {
  return {
    id: "routing",
    kind: "routing",
    label: "처리 경로 결정",
    detail: state === "running"
      ? "질문의 의도와 필요한 실행 범위를 확인하고 있습니다."
      : "질문에 맞는 처리 경로를 결정했습니다.",
    state,
  };
}

const toolCopy: Record<string, { label: string; activeLabel: string }> = {
  read_file: { label: "파일 확인", activeLabel: "파일을 확인하는 중" },
  search_files: { label: "코드 검색", activeLabel: "관련 코드를 찾는 중" },
  terminal: { label: "명령 실행", activeLabel: "명령을 실행하는 중" },
  execute_code: { label: "코드 실행", activeLabel: "코드를 실행하는 중" },
  patch: { label: "코드 수정", activeLabel: "코드를 수정하는 중" },
  write_file: { label: "파일 작성", activeLabel: "파일을 작성하는 중" },
  browser_navigate: { label: "브라우저 확인", activeLabel: "브라우저에서 확인하는 중" },
  delegate_task: { label: "전문 에이전트", activeLabel: "전문 에이전트가 작업하는 중" },
  todo: { label: "진행 계획", activeLabel: "진행 계획을 갱신하는 중" },
};

function firstDetail(args: Record<string, unknown>): string {
  for (const key of ["path", "query", "search_term", "command", "url", "goal"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      const normalized = value.replace(/\s+/g, " ").trim();
      return normalized.length > 100 ? `${normalized.slice(0, 97)}…` : normalized;
    }
  }
  return "Hermes 도구를 실행합니다.";
}

function readableToolName(toolName: string): string {
  return toolName
    .replace(/^functions\./, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function buildMobileChatProgress(input: MobileChatProgressInput): MobileChatProgressModel {
  if (input.sendingMessage) {
    return {
      visible: true,
      active: true,
      label: "Hermes에 요청 전달 중",
      rows: [requestRow("running")],
    };
  }

  if (input.turn?.status === "requested" || input.turn?.status === "routing") {
    return {
      visible: true,
      active: true,
      label: "처리 경로를 결정하는 중",
      rows: [
        requestRow("completed"),
        routingRow("running"),
      ],
    };
  }

  if (input.projection || input.turn) {
    const projection = input.projection;
    const toolParts = projection?.parts.filter((part) => part.type === "tool-call") ?? [];
    const toolRows: MobileChatProgressRow[] = toolParts.map((part) => ({
      id: `tool:${part.toolCallId}`,
      kind: "tool",
      label: toolCopy[part.toolName]?.label || readableToolName(part.toolName),
      detail: firstDetail(part.args),
      state: part.result === undefined ? "running" : part.isError ? "failed" : "completed",
    }));
    const specialistRows: MobileChatProgressRow[] = (input.orchestration?.specialists ?? []).map((specialist) => ({
      id: `specialist:${specialist.id}`,
      kind: "specialist",
      label: specialist.role,
      detail: specialist.resultSummary || specialist.mission,
      state: specialist.status === "completed"
        ? "completed"
        : specialist.status === "running"
          ? "running"
          : specialist.status === "failed" || specialist.status === "cancelled"
            ? "failed"
            : "pending",
    }));
    const runningTool = [...toolParts].reverse().find((part) => part.result === undefined);
    const runningSpecialists = input.orchestration?.specialists.filter((specialist) => specialist.status === "running") ?? [];
    const hasResponseText = projection?.parts.some((part) => part.type === "text" && part.text.trim()) ?? false;
    const active = Boolean(
      projection?.pending ||
      projection?.busy ||
      input.turn && !["completed", "failed", "cancelled"].includes(input.turn.status),
    );
    const responseState: MobileChatProgressRowState = projection?.error || input.turn?.status === "failed"
      ? "failed"
      : projection?.needsInput || input.turn?.status === "waiting_approval"
        ? "waiting"
        : input.turn?.status === "completed"
          ? "completed"
          : hasResponseText
            ? "running"
            : "pending";
    const label = projection?.needsInput || input.turn?.status === "waiting_approval"
      ? "사용자 입력 대기"
      : projection?.error || input.turn?.status === "failed"
        ? "응답 생성 실패"
        : runningTool
          ? toolCopy[runningTool.toolName]?.activeLabel || `${readableToolName(runningTool.toolName)} 실행 중`
          : runningSpecialists.length > 0
            ? `전문 에이전트 ${runningSpecialists.length}명이 작업 중`
            : input.orchestration?.status === "synthesizing"
              ? "전문 결과를 종합하는 중"
          : hasResponseText
            ? "응답을 작성하는 중"
            : input.turn?.status === "completed"
              ? "응답 완료"
              : "Hermes가 생각하는 중";

    return {
      visible: true,
      active,
      label,
      rows: [
        requestRow("completed"),
        routingRow("completed"),
        ...specialistRows,
        ...toolRows,
        {
          id: "response",
          kind: "response",
          label: "응답 작성",
          detail: responseState === "completed"
            ? "최종 응답을 완료했습니다."
            : responseState === "waiting"
              ? "계속하려면 사용자 입력이 필요합니다."
              : "확인한 내용을 바탕으로 답변을 준비합니다.",
          state: responseState,
        },
      ],
    };
  }

  return { visible: false, active: false, label: "", rows: [] };
}

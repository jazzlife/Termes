export type ExperienceKind = "mobile" | "tablet" | "desktop";
export type ExperiencePreference = "auto" | ExperienceKind;

export interface ExperienceEnvironment {
  viewportWidth: number;
  finePointer: boolean;
  hover: boolean;
}

const EXPERIENCE_RANK: Record<ExperienceKind, number> = {
  mobile: 0,
  tablet: 1,
  desktop: 2,
};

export function resolveAutomaticExperience(environment: ExperienceEnvironment): ExperienceKind {
  if (environment.viewportWidth < 820) return "mobile";
  if (environment.viewportWidth >= 1180 && environment.finePointer && environment.hover) return "desktop";
  return "tablet";
}

export function resolveExperience(
  environment: ExperienceEnvironment,
  preference: ExperiencePreference = "auto",
): ExperienceKind {
  const automatic = resolveAutomaticExperience(environment);
  if (preference === "auto") return automatic;
  return EXPERIENCE_RANK[preference] <= EXPERIENCE_RANK[automatic] ? preference : automatic;
}

export function readExperienceEnvironment(): ExperienceEnvironment {
  return {
    viewportWidth: window.innerWidth,
    finePointer: window.matchMedia("(pointer: fine)").matches,
    hover: window.matchMedia("(hover: hover)").matches,
  };
}

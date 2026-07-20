declare const __TERMES_BUILD_ID__: string;

const UPDATE_INTERVAL_MS = 60_000;
const INSTALL_PROMPT_DISMISSED_KEY = "termes.pwa.install.dismissed";
const ACTIVATED_MESSAGE = "TERMES_SW_ACTIVATED";

export type TermesPwaInstallMode = "native" | "ios" | "manual";

export interface TermesBeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export function isTermesPwaStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches === true
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function isIosPwaInstallCandidate(): boolean {
  if (typeof window === "undefined") return false;
  const navigatorWithPlatform = window.navigator as Navigator & { platform?: string };
  return /iPad|iPhone|iPod/.test(navigatorWithPlatform.userAgent)
    || (navigatorWithPlatform.platform === "MacIntel" && navigatorWithPlatform.maxTouchPoints > 1);
}

export function isTermesPwaInstallPromptDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function dismissTermesPwaInstallPrompt(): void {
  try {
    window.localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, "true");
  } catch {
    // Storage denial must not break the application shell.
  }
}

export function bootstrapTermesPwa(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  navigator.serviceWorker.addEventListener("message", (event) => {
    const message = event.data as { type?: unknown; buildId?: unknown } | null;
    if (message?.type !== ACTIVATED_MESSAGE || typeof message.buildId !== "string") return;
    if (message.buildId === __TERMES_BUILD_ID__) return;

    window.dispatchEvent(new CustomEvent("termes:pwa-updated", { detail: { buildId: message.buildId } }));
  });

  let lastUpdateAt = 0;
  const registerOrUpdate = async (): Promise<void> => {
    if (Date.now() - lastUpdateAt < UPDATE_INTERVAL_MS) return;
    lastUpdateAt = Date.now();

    try {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      await registration.update();
    } catch (cause) {
      console.error("Termes PWA service worker registration failed", cause);
    }
  };

  window.addEventListener("load", () => void registerOrUpdate(), { once: true });
  window.addEventListener("pageshow", () => void registerOrUpdate());
  window.setInterval(() => void registerOrUpdate(), UPDATE_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void registerOrUpdate();
  });
}

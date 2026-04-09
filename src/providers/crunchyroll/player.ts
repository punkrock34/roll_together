import type { EpisodeInfo } from "../../core/protocol";
import { stripRoomIdFromUrl } from "../../core/url";

export const CRUNCHYROLL_VIDEO_SELECTORS = [
  "video#player0",
  "video#bitmovinplayer-video-null",
  "video[data-testid='vilos-video']",
  "video",
];
const NEW_UI_BOTTOM_CONTROLS_SELECTOR =
  '[data-testid="bottom-controls-autohide"]';

export type CrunchyrollSeekMethod =
  | "react-seekTo"
  | "react-requestSeekToContentTime"
  | "fastSeek"
  | "currentTime";

export interface CrunchyrollSeekResult {
  method: CrunchyrollSeekMethod;
  targetTime: number;
}

type SearchRoot = Document | ShadowRoot;
type RectLike = Pick<
  DOMRect,
  "left" | "top" | "right" | "bottom" | "width" | "height"
>;

export function isCrunchyrollUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith("crunchyroll.com");
  } catch {
    return false;
  }
}

export function sanitizeCrunchyrollEpisodeUrl(url: string): string {
  const cleaned = stripRoomIdFromUrl(url);
  const parsed = new URL(cleaned);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function deriveEpisodeTitle(documentTitle: string): string {
  const cleaned = documentTitle
    .replace(/\s*[|-]\s*Crunchyroll.*$/i, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .trim();

  return cleaned || "Crunchyroll Episode";
}

export function extractEpisodeInfo(
  url: string,
  documentTitle: string,
): EpisodeInfo {
  return {
    provider: "crunchyroll",
    episodeId: deriveEpisodeId(url),
    episodeUrl: sanitizeCrunchyrollEpisodeUrl(url),
    episodeTitle: deriveEpisodeTitle(documentTitle),
  };
}

export function deriveEpisodeId(url: string): string {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/watch\/([^/?#]+)/i);
    if (match && match[1]) {
      return match[1];
    }
    return sanitizeCrunchyrollEpisodeUrl(url);
  } catch {
    return url;
  }
}

export function findCrunchyrollPlayer(
  doc: Document = document,
): HTMLVideoElement | null {
  const seen = new Set<HTMLVideoElement>();

  for (const root of collectSearchRoots(doc)) {
    for (const selector of CRUNCHYROLL_VIDEO_SELECTORS) {
      const candidates = Array.from(root.querySelectorAll(selector)).filter(
        (node): node is HTMLVideoElement => node instanceof HTMLVideoElement,
      );

      for (const candidate of candidates) {
        if (!isCandidateUsable(candidate)) {
          continue;
        }

        if (!seen.has(candidate)) {
          seen.add(candidate);
        }
      }
    }
  }

  const ranked = Array.from(seen).sort(
    (left, right) => scoreVideo(right) - scoreVideo(left),
  );

  return ranked[0] ?? null;
}

export function seekCrunchyrollPlayer(
  video: HTMLVideoElement,
  targetTime: number,
): CrunchyrollSeekResult {
  const normalizedTargetTime = Number.isFinite(targetTime)
    ? Math.max(0, targetTime)
    : 0;

  const newUiSeekTo = getNewUiSeekTo(video.ownerDocument);
  if (newUiSeekTo) {
    newUiSeekTo(normalizedTargetTime);
    return {
      method: "react-seekTo",
      targetTime: normalizedTargetTime,
    };
  }

  const legacySeekTo = getLegacyPlayerActionSeek(video);
  if (legacySeekTo) {
    legacySeekTo(normalizedTargetTime);
    return {
      method: "react-requestSeekToContentTime",
      targetTime: normalizedTargetTime,
    };
  }

  if (typeof video.fastSeek === "function") {
    try {
      video.fastSeek(normalizedTargetTime);
      return {
        method: "fastSeek",
        targetTime: normalizedTargetTime,
      };
    } catch {
      // Fall through to currentTime assignment when fastSeek is unsupported at runtime.
    }
  }

  video.currentTime = normalizedTargetTime;
  return {
    method: "currentTime",
    targetTime: normalizedTargetTime,
  };
}

function collectSearchRoots(doc: Document): SearchRoot[] {
  const roots: SearchRoot[] = [doc];
  const queue: SearchRoot[] = [doc];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const elements = Array.from(current.querySelectorAll("*"));
    for (const element of elements) {
      if (element.shadowRoot) {
        roots.push(element.shadowRoot);
        queue.push(element.shadowRoot);
      }
    }
  }

  return roots;
}

function getReactFiberNode(
  element: Element | null,
): Record<string, unknown> | null {
  if (!element) {
    return null;
  }

  const key = Object.keys(element).find(
    (candidate) =>
      candidate.startsWith("__reactFiber$") ||
      candidate.startsWith("__reactInternal"),
  );
  if (!key) {
    return null;
  }

  const node = (element as unknown as Record<string, unknown>)[key];
  if (!node || typeof node !== "object") {
    return null;
  }

  return node as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function getNewUiSeekTo(doc: Document): ((time: number) => void) | null {
  const controls = doc.querySelector(NEW_UI_BOTTOM_CONTROLS_SELECTOR);
  const fiberNode = getReactFiberNode(controls);
  if (!fiberNode) {
    return null;
  }

  const child1 = asRecord(fiberNode.child);
  const child2 = asRecord(child1?.child);
  const child3 = asRecord(child2?.child);
  const child4 = asRecord(child3?.child);
  const memoizedProps = asRecord(child4?.memoizedProps);
  const seekTo = memoizedProps?.seekTo;

  if (typeof seekTo !== "function") {
    return null;
  }
  return seekTo as (time: number) => void;
}

function getLegacyPlayerActionSeek(
  video: HTMLVideoElement,
): ((time: number) => void) | null {
  const fiberNode = getReactFiberNode(video);
  if (!fiberNode) {
    return null;
  }

  const returnNode = asRecord(fiberNode.return);
  const stateNode = asRecord(returnNode?.stateNode);
  const props = asRecord(stateNode?.props);
  const playerActions = asRecord(props?.playerActions);
  const requestSeekToContentTime = playerActions?.requestSeekToContentTime;

  if (typeof requestSeekToContentTime !== "function") {
    return null;
  }

  return requestSeekToContentTime as (time: number) => void;
}

function scoreVideo(video: HTMLVideoElement): number {
  const rect = video.getBoundingClientRect();
  const visibleArea = getVisibleViewportArea(rect);

  return (
    Number(video.id === "player0") * 30 +
    Number(video.id === "bitmovinplayer-video-null") * 28 +
    Number(video.dataset.testid === "vilos-video") * 26 +
    Number(video.readyState > 0) * 20 +
    Number(Number.isFinite(video.duration) && video.duration > 0) * 14 +
    Number(video.currentTime > 0) * 6 +
    Number(!video.paused) * 4 +
    Number(video.readyState >= 2) * 3 +
    Math.min(visibleArea / 10_000, 12)
  );
}

function isCandidateUsable(video: HTMLVideoElement) {
  if (!video.isConnected) {
    return false;
  }

  const isPrimaryBySelector =
    video.id === "player0" ||
    video.id === "bitmovinplayer-video-null" ||
    video.dataset.testid === "vilos-video";

  const rect = video.getBoundingClientRect();
  const hasMeasuredSize = rect.width > 0 && rect.height > 0;
  const hasEnoughMeasuredSize = rect.width >= 200 && rect.height >= 100;
  const visibleViewportArea = getVisibleViewportArea(rect);
  const hasEnoughVisibleViewportArea = visibleViewportArea >= 20_000;

  if (isEffectivelyHidden(video)) {
    return false;
  }

  if (visibleViewportArea <= 0) {
    return false;
  }

  if (
    hasMeasuredSize &&
    (!hasEnoughMeasuredSize || !hasEnoughVisibleViewportArea)
  ) {
    return false;
  }

  const hasPlaybackSignal =
    video.readyState > 0 ||
    video.currentTime > 0 ||
    (Number.isFinite(video.duration) && video.duration > 0);

  if (!hasPlaybackSignal && !isPrimaryBySelector) {
    return false;
  }

  return true;
}

function getVisibleViewportArea(rect: RectLike) {
  if (rect.width <= 0 || rect.height <= 0) {
    return 0;
  }

  const viewportWidth =
    window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight =
    window.innerHeight || document.documentElement.clientHeight;

  const visibleLeft = Math.max(0, rect.left);
  const visibleTop = Math.max(0, rect.top);
  const visibleRight = Math.min(viewportWidth, rect.right);
  const visibleBottom = Math.min(viewportHeight, rect.bottom);

  const visibleWidth = Math.max(0, visibleRight - visibleLeft);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);

  return visibleWidth * visibleHeight;
}

function isEffectivelyHidden(video: HTMLVideoElement) {
  const view = video.ownerDocument.defaultView;
  if (!view) {
    return false;
  }

  const style = view.getComputedStyle(video);
  if (style.display === "none" || style.visibility === "hidden") {
    return true;
  }

  const opacity = Number.parseFloat(style.opacity);
  if (Number.isFinite(opacity) && opacity <= 0) {
    return true;
  }

  return false;
}

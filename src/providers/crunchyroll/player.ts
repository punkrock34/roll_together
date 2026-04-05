import type { EpisodeInfo } from "../../core/protocol";
import { stripRoomIdFromUrl } from "../../core/url";

export const CRUNCHYROLL_VIDEO_SELECTORS = [
  "video#player0",
  "video#bitmovinplayer-video-null",
  "video[data-testid='vilos-video']",
  "video",
];

type SearchRoot = Document | ShadowRoot;

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
    episodeUrl: sanitizeCrunchyrollEpisodeUrl(url),
    episodeTitle: deriveEpisodeTitle(documentTitle),
  };
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

function collectSearchRoots(doc: Document): SearchRoot[] {
  const roots: SearchRoot[] = [doc];
  const queue: SearchRoot[] = [doc];
  const visitedDocuments = new Set<Document>([doc]);

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

      if (element instanceof HTMLIFrameElement) {
        const frameDocument = getAccessibleFrameDocument(element);
        if (frameDocument && !visitedDocuments.has(frameDocument)) {
          visitedDocuments.add(frameDocument);
          roots.push(frameDocument);
          queue.push(frameDocument);
        }
      }
    }
  }

  return roots;
}

function getAccessibleFrameDocument(
  frame: HTMLIFrameElement,
): Document | undefined {
  try {
    return frame.contentDocument ?? undefined;
  } catch {
    return undefined;
  }
}

function scoreVideo(video: HTMLVideoElement): number {
  const rect = video.getBoundingClientRect();
  const visibleArea = rect.width * rect.height;

  return (
    Number(video.readyState > 0) * 20 +
    Number(Number.isFinite(video.duration) && video.duration > 0) * 14 +
    Number(video.currentTime > 0) * 6 +
    Number(!video.paused) * 4 +
    Math.min(visibleArea / 10_000, 10)
  );
}

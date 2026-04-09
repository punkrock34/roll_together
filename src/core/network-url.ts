function isIpv4Address(hostname: string) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
}

function isPrivateOrLoopbackIpv4(hostname: string) {
  if (!isIpv4Address(hostname)) {
    return false;
  }

  const octets = hostname.split(".").map((segment) => Number(segment));
  if (
    octets.length !== 4 ||
    octets.some(
      (segment) => Number.isNaN(segment) || segment < 0 || segment > 255,
    )
  ) {
    return false;
  }

  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return (
    first === 10 ||
    first === 127 ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 169 && second === 254)
  );
}

function isLocalIpv6(hostname: string) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

export function isLocalLikeHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }

  if (isPrivateOrLoopbackIpv4(normalized)) {
    return true;
  }

  if (normalized.includes(":") && isLocalIpv6(normalized)) {
    return true;
  }

  return false;
}

export function isRemotePlainWsUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "ws:" && !isLocalLikeHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function normalizeBackendWsUrl(rawUrl: string) {
  const trimmed = rawUrl.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "ws:" && !isLocalLikeHostname(parsed.hostname)) {
      parsed.protocol = "wss:";
      return parsed.toString();
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}

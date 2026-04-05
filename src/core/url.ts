import { ROOM_QUERY_PARAM } from "./protocol";

export function getRoomIdFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get(ROOM_QUERY_PARAM);
  } catch {
    return null;
  }
}

export function stripRoomIdFromUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete(ROOM_QUERY_PARAM);
  parsed.hash = "";
  return parsed.toString();
}

export function buildRoomInviteUrl(url: string, roomId: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(ROOM_QUERY_PARAM, roomId);
  return parsed.toString();
}

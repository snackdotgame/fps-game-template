// Reliable-stream messages (JSON): roster, team scores, kill feed, round
// flow, and — crucially — destruction and construction. Panel changes must
// arrive exactly once on every client (they alter collision), and QUIC
// streams give guaranteed ordered delivery for free.

import type { Crater, PanelDef } from "./map.js";

export interface PlayerInfo {
  idx: number;
  name: string;
  team: number;
}

export type ServerMsg =
  | {
      type: "welcome";
      selfIdx: number;
      players: PlayerInfo[];
      serverTick: number;
      phase: "playing" | "results";
      phaseEndTick: number;
      scores: [number, number];
      mapEpoch: number; // bumps every round restart (map fully restored)
      destroyed: number[]; // panel ids gone this round
      built: PanelDef[]; // deployed cover + rubble chunks alive this round
      collapsed: number[]; // building ids that crumbled this round
      panelHp: Array<[number, number]>; // damaged-but-alive panels
      craters: Crater[]; // terrain digs this round
    }
  | { type: "join"; player: PlayerInfo }
  | { type: "leave"; idx: number }
  | { type: "kill"; killer: number; victim: number; weapon: "rifle" | "grenade" | "melee" }
  | { type: "destroy"; panelIds: number[] }
  | { type: "panelhp"; updates: Array<[number, number]> } // [panelId, hp]
  | { type: "collapse"; buildingId: number }
  // A piece lost its support and is now tumbling (cosmetic on clients; the
  // server simulates it). fromId is the static piece that was removed.
  | { type: "fall"; piece: PanelDef; fromId: number }
  // A fallen piece came to rest: it re-enters the world as a static,
  // destructible piece at this pose. Carries the full def so even clients
  // that missed the fall can materialize it.
  | { type: "settle"; piece: PanelDef }
  | { type: "crater"; crater: Crater }
  | { type: "build"; panel: PanelDef; byIdx: number }
  | { type: "score"; scores: [number, number] }
  | {
      type: "phase";
      phase: "playing" | "results";
      phaseEndTick: number;
      scores: [number, number];
      mapEpoch: number;
    };

export function parseServerMsg(data: unknown): ServerMsg | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const t = (data as { type?: unknown }).type;
  if (typeof t !== "string") return null;
  return data as ServerMsg;
}

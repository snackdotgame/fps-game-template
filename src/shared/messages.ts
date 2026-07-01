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
  | { type: "kill"; killer: number; victim: number; weapon: "rifle" | "grenade" | "melee" | "oob" }
  | { type: "destroy"; panelIds: number[] }
  | { type: "panelhp"; updates: Array<[number, number]> } // [panelId, hp]
  | { type: "collapse"; buildingId: number }
  // A connected cluster of pieces lost its support and is now ONE rigid
  // chunk tumbling under the server's simulation. pieces carry world-space
  // poses at the moment of release; origin is the chunk's reference frame,
  // and live poses stream inside snapshots until the chunk settles.
  | { type: "fall"; chunkId: number; origin: [number, number, number]; pieces: PanelDef[] }
  // The chunk came to rest and split back into individual static,
  // destructible pieces at their final poses. Carries full defs so even
  // clients that missed the fall can materialize them.
  | { type: "settle"; chunkId: number; pieces: PanelDef[] }
  | { type: "crater"; crater: Crater }
  | { type: "build"; panel: PanelDef; byIdx: number }
  // Explosion debris fragments, batched into one message per tick: a single
  // grenade can shed dozens, and one reliable write per fragment floods the
  // stream (writes get dropped → destruction desyncs until the next reload).
  | { type: "rubble"; panels: PanelDef[] }
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

// --- Client -> server requests (reliable stream). ---

// Spawn-point preference from the deploy/respawn map: a zone index to spawn
// at that flag while the team holds it, or one of the sentinels.
export const SPAWN_AUTO = -1; // server picks (base or a random safe flag)
export const SPAWN_HQ = -2; // always the team base

export type ClientMsg =
  | { type: "spawnat"; zone: number }
  // Deploy request while dead: humans respawn only when they ask (once the
  // respawn timer allows), never automatically.
  | { type: "deploy" }
  // Class pick (CLASSES index); takes effect at the next spawn.
  | { type: "class"; cls: number };

export function parseClientMsg(data: unknown): ClientMsg | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const m = data as { type?: unknown; zone?: unknown; cls?: unknown };
  if (m.type === "deploy") return { type: "deploy" };
  if (m.type === "class") {
    if (typeof m.cls !== "number" || !Number.isFinite(m.cls)) return null;
    return { type: "class", cls: Math.round(m.cls) };
  }
  if (m.type !== "spawnat" || typeof m.zone !== "number" || !Number.isFinite(m.zone)) return null;
  return { type: "spawnat", zone: Math.round(m.zone) };
}

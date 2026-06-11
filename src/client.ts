// Browser client: first-person rendering, local prediction over a mirror Jolt
// world, remote interpolation, destruction/construction sync, and the HUD.
// The server is authoritative for everything; this file is display + input.

import { client } from "minion:client";
import * as THREE from "three";
import {
  INPUT_REDUNDANCY,
  MAX_HP,
  REMOTE_DELAY_MS,
  TEAM_NAMES,
  TICK_MS,
  TICK_RATE,
} from "./shared/constants.js";
import { MAP, type PanelDef, panelExtents } from "./shared/map.js";
import { parseServerMsg, type PlayerInfo } from "./shared/messages.js";
import {
  decodeSnapshot,
  encodeInputs,
  EV_EXPLOSION,
  EV_HIT_PLAYER,
  EV_MELEE,
  EV_PANEL_HIT,
  EV_TRACER,
  type GameEvent,
  quantizeAngle,
  quantizeMove,
  RF_DEAD,
  RF_PROTECTED,
  RF_TEAM,
  type Snapshot,
  SS_DEAD,
} from "./shared/netCodec.js";
import {
  addPanelBody,
  type Body,
  buildPlacement,
  type CharState,
  createGameWorld,
  createGrenadeBody,
  createPlayerBody,
  destroyGameWorld,
  EYE_HEIGHT,
  type GameWorld,
  type InputCmd,
  makeChar,
  PLAYER_HALF_HEIGHT,
  readChar,
  removeGrenadeBody,
  removePanelBody,
  stepPlayerController,
  writeChar,
  ZERO_INPUT,
} from "./shared/physics.js";

const TEAM_COLORS = [0xe8743a, 0x3a7be8];
const TEAM_COLORS_CSS = ["#e8743a", "#3a7be8"];

// ---------------------------------------------------------------------------
// Renderer / scene.

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.style.cssText = "margin:0;overflow:hidden;background:#0c0f14;";
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb8cfe0);
scene.fog = new THREE.Fog(0xb8cfe0, 70, 160);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.08, 250);
const hemi = new THREE.HemisphereLight(0xe8f1fa, 0x6e6a5e, 1.0);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 2.0);
sun.position.set(35, 50, -25);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 160;
const span = MAP.size / 2 + 8;
sun.shadow.camera.left = -span;
sun.shadow.camera.right = span;
sun.shadow.camera.top = span;
sun.shadow.camera.bottom = -span;
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(sun.target);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Map visuals.

const MAT = {
  ground: new THREE.MeshLambertMaterial({ color: 0x8a9a6b }),
  wall: new THREE.MeshLambertMaterial({ color: 0x9b958a }),
  crate: new THREE.MeshLambertMaterial({ color: 0x8a6f4d }),
  panel: new THREE.MeshLambertMaterial({ color: 0xb9b2a6 }),
  panelRoof: new THREE.MeshLambertMaterial({ color: 0xa39a8a }),
  built: new THREE.MeshLambertMaterial({ color: 0x7d8a96 }),
  debris: new THREE.MeshLambertMaterial({ color: 0xa59c8e }),
};

let mapGroup = new THREE.Group();
scene.add(mapGroup);
const panelMeshes = new Map<number, THREE.Mesh>();

function panelMesh(p: PanelDef, built: boolean): THREE.Mesh {
  const [w, h, d] = panelExtents(p.orient);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    built ? MAT.built : p.orient === "flat" ? MAT.panelRoof : MAT.panel,
  );
  mesh.position.set(p.x, p.y, p.z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildMapVisuals(): void {
  scene.remove(mapGroup);
  mapGroup = new THREE.Group();
  scene.add(mapGroup);
  panelMeshes.clear();

  for (const s of MAP.statics) {
    const mat = s.kind === "ground" ? MAT.ground : s.kind === "crate" ? MAT.crate : MAT.wall;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.d), mat);
    mesh.position.set(s.x, s.y, s.z);
    mesh.castShadow = s.kind !== "ground";
    mesh.receiveShadow = true;
    mapGroup.add(mesh);
  }
  for (const p of MAP.panels) {
    const mesh = panelMesh(p, false);
    mapGroup.add(mesh);
    panelMeshes.set(p.id, mesh);
  }
}

function addBuiltPanelVisual(p: PanelDef): void {
  const mesh = panelMesh(p, true);
  mapGroup.add(mesh);
  panelMeshes.set(p.id, mesh);
}

function removePanelVisual(id: number, withDebris: boolean): void {
  const mesh = panelMeshes.get(id);
  if (!mesh) return;
  if (withDebris) spawnDebris(mesh.position, 6);
  mapGroup.remove(mesh);
  mesh.geometry.dispose();
  panelMeshes.delete(id);
}

// ---------------------------------------------------------------------------
// HUD.

const hud = document.createElement("div");
hud.innerHTML = `
<style>
  #hud { position:fixed; inset:0; pointer-events:none; font-family:"Trebuchet MS",system-ui,sans-serif; color:#fff; user-select:none; }
  .sh { text-shadow: 0 1px 2px rgba(0,0,0,.7); }
  #cross { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); font-size:22px; opacity:.9; }
  #hitmark { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%) rotate(45deg); font-size:26px; color:#ff5a4a; opacity:0; font-weight:900; }
  #scores { position:absolute; top:12px; left:50%; transform:translateX(-50%); font-size:22px; font-weight:900; background:rgba(10,14,22,.55); padding:6px 18px; border-radius:10px; }
  #timer { position:absolute; top:48px; left:50%; transform:translateX(-50%); font-size:14px; font-weight:700; opacity:.85; }
  #vitals { position:absolute; bottom:18px; left:18px; font-size:15px; font-weight:800; }
  #vitals .hpbar { width:200px; height:10px; background:rgba(0,0,0,.45); border-radius:5px; overflow:hidden; margin-top:4px; }
  #vitals .hpbar div { height:100%; background:#5ad05a; width:100%; }
  #ammo { position:absolute; bottom:18px; right:22px; text-align:right; font-weight:900; }
  #ammo .mag { font-size:34px; }
  #ammo .sub { font-size:14px; opacity:.85; }
  #feed { position:absolute; top:14px; right:14px; text-align:right; font-size:14px; font-weight:700; }
  #feed div { margin:2px 0; background:rgba(10,14,22,.5); padding:3px 9px; border-radius:7px; }
  #overlay { position:absolute; inset:0; display:none; align-items:center; justify-content:center; text-align:center; background:rgba(8,10,16,.45); }
  #overlay .panel { background:rgba(12,16,26,.9); border-radius:16px; padding:26px 44px; }
  #overlay h1 { margin:0 0 6px; font-size:40px; }
  #overlay p { margin:4px 0; font-size:17px; }
  #board { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); display:none; background:rgba(12,16,26,.92); border-radius:14px; padding:18px 30px; font-size:15px; }
  #board table { border-collapse:collapse; }
  #board td, #board th { padding:3px 14px; text-align:left; }
  #hint { position:absolute; bottom:6px; left:50%; transform:translateX(-50%); font-size:12px; opacity:.75; }
  #netinfo { position:absolute; bottom:4px; right:8px; font-size:11px; opacity:.65; }
  #vignette { position:absolute; inset:0; box-shadow: inset 0 0 140px rgba(255,30,30,.85); opacity:0; transition:opacity .12s; }
  #flash { position:absolute; inset:0; background:#fff; opacity:0; }
</style>
<div id="hud">
  <div id="vignette"></div>
  <div id="flash"></div>
  <div id="cross" class="sh">+</div>
  <div id="hitmark">+</div>
  <div id="scores" class="sh"></div>
  <div id="timer" class="sh"></div>
  <div id="vitals" class="sh">HP<div class="hpbar"><div id="hpfill"></div></div></div>
  <div id="ammo" class="sh"><div class="mag" id="ammotext">30</div><div class="sub" id="gear"></div></div>
  <div id="feed"></div>
  <div id="overlay"><div class="panel" id="overlaypanel"></div></div>
  <div id="board"></div>
  <div id="hint" class="sh">click to play — WASD move · shift sprint · space jump · LMB fire · R reload · G grenade · F sledge · Q build cover · Tab scores</div>
  <div id="netinfo" class="sh"></div>
</div>`;
document.body.appendChild(hud);
const el = {
  cross: document.getElementById("cross")!,
  hitmark: document.getElementById("hitmark")!,
  scores: document.getElementById("scores")!,
  timer: document.getElementById("timer")!,
  hpfill: document.getElementById("hpfill")!,
  ammotext: document.getElementById("ammotext")!,
  gear: document.getElementById("gear")!,
  feed: document.getElementById("feed")!,
  overlay: document.getElementById("overlay")!,
  overlaypanel: document.getElementById("overlaypanel")!,
  board: document.getElementById("board")!,
  netinfo: document.getElementById("netinfo")!,
  vignette: document.getElementById("vignette")!,
  flash: document.getElementById("flash")!,
};

function feed(text: string): void {
  const d = document.createElement("div");
  d.innerHTML = text;
  el.feed.prepend(d);
  while (el.feed.children.length > 6) el.feed.lastChild?.remove();
  setTimeout(() => d.remove(), 6000);
}

// ---------------------------------------------------------------------------
// Audio (synthesized).

let audioCtx: AudioContext | null = null;
function ensureAudio(): void {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") void audioCtx.resume();
}
function noiseBurst(dur: number, vol: number, low = false): void {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const len = Math.floor(audioCtx.sampleRate * dur);
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const filter = audioCtx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = low ? 220 : 2600;
  const gain = audioCtx.createGain();
  gain.gain.value = vol;
  src.connect(filter).connect(gain).connect(audioCtx.destination);
  src.start(t);
}
function blip(freq: number, dur = 0.07, vol = 0.1, type: OscillatorType = "square"): void {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + dur);
}
const sounds = {
  shot: () => noiseBurst(0.09, 0.16),
  shotFar: (d: number) => noiseBurst(0.12, Math.max(0.02, 0.14 - d * 0.002), true),
  explosion: () => {
    noiseBurst(0.5, 0.4, true);
    blip(60, 0.45, 0.25, "sine");
  },
  hitmarker: () => blip(1300, 0.05, 0.12),
  hurt: () => blip(170, 0.12, 0.16, "sawtooth"),
  reload: () => blip(700, 0.06, 0.08),
  build: () => blip(240, 0.1, 0.14, "square"),
  melee: () => noiseBurst(0.08, 0.1, true),
  death: () => blip(110, 0.5, 0.2, "sawtooth"),
};

// ---------------------------------------------------------------------------
// Input.

const keys = new Set<string>();
let yaw = 0;
let pitch = 0;
let pointerLocked = false;
let fireHeld = false;

renderer.domElement.addEventListener("mousedown", (e) => {
  ensureAudio();
  if (!pointerLocked) {
    renderer.domElement.requestPointerLock();
    return;
  }
  if (e.button === 0) fireHeld = true;
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 0) fireHeld = false;
});
document.addEventListener("pointerlockchange", () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
  if (!pointerLocked) fireHeld = false;
});
document.addEventListener("mousemove", (e) => {
  if (!pointerLocked) return;
  yaw -= e.movementX * 0.0023;
  pitch = Math.max(-1.45, Math.min(1.45, pitch - e.movementY * 0.0021));
  while (yaw > Math.PI) yaw -= Math.PI * 2;
  while (yaw < -Math.PI) yaw += Math.PI * 2;
});
window.addEventListener("keydown", (e) => {
  if (e.code === "Tab") e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  ensureAudio();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => {
  keys.clear();
  fireHeld = false;
});

// Test hook: scripted input overrides everything for N ticks.
let driven: (Omit<InputCmd, "seq"> & { ticks: number }) | null = null;

function sampleInput(seq: number): InputCmd {
  if (driven && driven.ticks > 0) {
    driven.ticks--;
    const { ticks: _ticks, ...rest } = driven;
    return { seq, ...rest };
  }
  let fwd = 0;
  let side = 0;
  if (keys.has("KeyW")) fwd += 1;
  if (keys.has("KeyS")) fwd -= 1;
  if (keys.has("KeyA")) side += 1;
  if (keys.has("KeyD")) side -= 1;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return {
    seq,
    moveX: quantizeMove(fwd * sin + side * cos),
    moveZ: quantizeMove(fwd * cos - side * sin),
    yaw: quantizeAngle(yaw),
    pitch: quantizeAngle(pitch),
    jump: keys.has("Space"),
    sprint: keys.has("ShiftLeft") || keys.has("ShiftRight"),
    fire: fireHeld,
    reload: keys.has("KeyR"),
    grenade: keys.has("KeyG"),
    melee: keys.has("KeyF"),
    build: keys.has("KeyQ"),
  };
}

// ---------------------------------------------------------------------------
// Game state + prediction.

interface RemotePlayer {
  info: PlayerInfo;
  group: THREE.Group;
  buffer: Array<{
    t: number;
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    flags: number;
  }>;
  lastFlags: number;
}

let selfIdx = -1;
let phase: "playing" | "results" = "playing";
let phaseEndTick = 0;
let mapEpoch = 0;
let scores: [number, number] = [0, 0];
const roster = new Map<number, PlayerInfo>();
const remotes = new Map<number, RemotePlayer>();
const kd = new Map<number, { k: number; d: number }>();
let selfStatus = 0;
let selfHp = MAX_HP;
let respawnTicks = 0;

let gw: GameWorld | null = null;
let selfBody: Body | null = null;
let worldBuildSeq = 0;
const ghostBodies = new Map<number, Body>();
let seq = 0;
let predState: CharState | null = null;
const history: Array<{ seq: number; cmd: InputCmd }> = [];
let lastAckSeq = 0;
let lastAckTick = 0;
let lastSnapAtMs = 0;
let rollbacks = 0;
let snapshotsSeen = 0;
let needHardAdopt = true;
const errOffset = new THREE.Vector3();
let lastEventSeq = 0;
let destroyedSet = new Set<number>();
let builtList: PanelDef[] = [];

// Input-rate servo (see snack-dash): hold the server buffer at a small depth.
const TARGET_DEPTH = 3;
let depthEma = TARGET_DEPTH;
let serverTickRefTick = 0;
let serverTickRefAtMs = 0;

function estimatedServerTickNow(): number {
  if (serverTickRefAtMs === 0) return 0;
  return serverTickRefTick + (performance.now() - serverTickRefAtMs) / TICK_MS;
}

function estServerTick(): number {
  return lastAckTick + (seq - lastAckSeq);
}

function copyCtrl(into: CharState, from: CharState): void {
  into.onGround = from.onGround;
  into.jumpHeld = from.jumpHeld;
  into.fireHeld = from.fireHeld;
  into.grenadeHeld = from.grenadeHeld;
  into.meleeHeld = from.meleeHeld;
  into.buildHeld = from.buildHeld;
  into.coyoteTicks = from.coyoteTicks;
  into.cooldownTicks = from.cooldownTicks;
  into.reloadTicks = from.reloadTicks;
  into.ammo = from.ammo;
  into.grenades = from.grenades;
  into.supply = from.supply;
}

async function buildWorlds(): Promise<void> {
  const buildId = ++worldBuildSeq;
  needHardAdopt = true;
  buildMapVisuals();
  const next = await createGameWorld();
  if (buildId !== worldBuildSeq) {
    destroyGameWorld(next);
    return;
  }
  if (gw) destroyGameWorld(gw);
  ghostBodies.clear();
  gw = next;
  selfBody = createPlayerBody(gw, Math.max(0, selfIdx), [0, 2, 0]);
  if (!predState) predState = makeChar([0, 2, 0]);
  // Re-apply this round's destruction/construction.
  for (const p of builtList) {
    addPanelBody(gw, p);
    addBuiltPanelVisual(p);
  }
  for (const id of destroyedSet) {
    removePanelBody(gw, id);
    removePanelVisual(id, false);
  }
}

// --- Streams.

async function readStreams(): Promise<void> {
  try {
    while (true) {
      const event = await client.streams.recv();
      const msg = parseServerMsg(event.json());
      if (msg) handleServerMsg(msg);
    }
  } catch {
    await client.closed;
  }
}

function nameOf(idx: number): string {
  return roster.get(idx)?.name ?? `player ${idx}`;
}

function teamSpan(idx: number): string {
  const team = roster.get(idx)?.team ?? 0;
  return `<span style="color:${TEAM_COLORS_CSS[team]}">${escapeHtml(nameOf(idx))}</span>`;
}

function handleServerMsg(msg: NonNullable<ReturnType<typeof parseServerMsg>>): void {
  switch (msg.type) {
    case "welcome": {
      selfIdx = msg.selfIdx;
      roster.clear();
      for (const p of msg.players) roster.set(p.idx, p);
      phase = msg.phase;
      phaseEndTick = msg.phaseEndTick;
      scores = [msg.scores[0], msg.scores[1]];
      mapEpoch = msg.mapEpoch;
      destroyedSet = new Set(msg.destroyed);
      builtList = [...msg.built];
      lastAckTick = msg.serverTick;
      void buildWorlds();
      break;
    }
    case "join": {
      roster.set(msg.player.idx, msg.player);
      if (msg.player.idx !== selfIdx) {
        feed(`${teamSpan(msg.player.idx)} joined`);
      }
      break;
    }
    case "leave": {
      const info = roster.get(msg.idx);
      if (info) feed(`${teamSpan(msg.idx)} left`);
      roster.delete(msg.idx);
      kd.delete(msg.idx);
      dropRemote(msg.idx);
      break;
    }
    case "kill": {
      const icon = msg.weapon === "grenade" ? "💥" : msg.weapon === "melee" ? "🔨" : "•";
      feed(`${teamSpan(msg.killer)} ${icon} ${teamSpan(msg.victim)}`);
      bumpKd(msg.killer, "k");
      bumpKd(msg.victim, "d");
      if (msg.victim === selfIdx) sounds.death();
      if (msg.killer === selfIdx && msg.victim !== selfIdx) sounds.hitmarker();
      break;
    }
    case "destroy": {
      for (const id of msg.panelIds) {
        destroyedSet.add(id);
        builtList = builtList.filter((p) => p.id !== id);
        if (gw) removePanelBody(gw, id);
        removePanelVisual(id, true);
      }
      break;
    }
    case "build": {
      builtList.push(msg.panel);
      if (gw) addPanelBody(gw, msg.panel);
      addBuiltPanelVisual(msg.panel);
      sounds.build();
      break;
    }
    case "score": {
      scores = [msg.scores[0], msg.scores[1]];
      break;
    }
    case "phase": {
      phase = msg.phase;
      phaseEndTick = msg.phaseEndTick;
      scores = [msg.scores[0], msg.scores[1]];
      if (msg.mapEpoch !== mapEpoch) {
        mapEpoch = msg.mapEpoch;
        destroyedSet.clear();
        builtList = [];
        kd.clear();
        void buildWorlds();
      }
      break;
    }
  }
}

function bumpKd(idx: number, which: "k" | "d"): void {
  const e = kd.get(idx) ?? { k: 0, d: 0 };
  if (which === "k") e.k++;
  else e.d++;
  kd.set(idx, e);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// --- Snapshots.

async function readDatagrams(): Promise<void> {
  try {
    while (true) {
      const event = await client.datagrams.recv();
      const snap = decodeSnapshot(event.bytes);
      if (snap) handleSnapshot(snap, event.receivedAt);
    }
  } catch {
    await client.closed;
  }
}

function handleSnapshot(snap: Snapshot, receivedAt: number): void {
  snapshotsSeen++;
  if (lastSnapAtMs > 0 && receivedAt - lastSnapAtMs > 1500) needHardAdopt = true;
  lastSnapAtMs = receivedAt;

  selfStatus = snap.self.status;
  selfHp = snap.self.hp;
  respawnTicks = snap.self.respawnTicks;
  phase = snap.phase === 0 ? "playing" : "results";
  phaseEndTick = snap.phaseEndTick;
  depthEma = depthEma * 0.9 + snap.self.bufferDepth * 0.1;

  const est = estimatedServerTickNow();
  if (serverTickRefAtMs === 0 || Math.abs(est - snap.serverTick) > 5) {
    serverTickRefTick = snap.serverTick;
  } else {
    serverTickRefTick = est * 0.9 + snap.serverTick * 0.1;
  }
  serverTickRefAtMs = receivedAt;

  // Remotes -> interpolation buffers.
  const seen = new Set<number>();
  for (const r of snap.remotes) {
    seen.add(r.idx);
    let rp = remotes.get(r.idx);
    if (!rp) {
      rp = {
        info: roster.get(r.idx) ?? {
          idx: r.idx,
          name: `player ${r.idx}`,
          team: (r.flags & RF_TEAM) !== 0 ? 1 : 0,
        },
        group: makeSoldier((r.flags & RF_TEAM) !== 0 ? 1 : 0, nameOf(r.idx)),
        buffer: [],
        lastFlags: 0,
      };
      remotes.set(r.idx, rp);
    }
    rp.buffer.push({
      t: receivedAt,
      x: r.x,
      y: r.y,
      z: r.z,
      yaw: r.yaw,
      pitch: r.pitch,
      flags: r.flags,
    });
    if (rp.buffer.length > 40) rp.buffer.splice(0, rp.buffer.length - 40);
    rp.lastFlags = r.flags;
  }
  for (const idx of remotes.keys()) {
    if (!seen.has(idx) && !roster.has(idx)) dropRemote(idx);
  }

  processEvents(snap.events);
  updateGrenadeViews(snap);

  const ack = snap.self;
  lastAckSeq = ack.ackSeq;
  lastAckTick = ack.ackTick;

  if (!gw || !selfBody || !predState) return;

  if (needHardAdopt) {
    writeChar(selfBody, ack.state);
    copyCtrl(predState, ack.state);
    readChar(selfBody, predState);
    syncGhosts(snap);
    syncGrenades(snap);
    history.length = 0;
    errOffset.set(0, 0, 0);
    needHardAdopt = false;
    return;
  }

  // Restore whole mirror world from the snapshot, replay pending inputs.
  const before = selfBody.translation();
  writeChar(selfBody, ack.state);
  copyCtrl(predState, ack.state);
  syncGhosts(snap);
  syncGrenades(snap);

  while (history.length > 0 && history[0].seq <= ack.ackSeq) history.shift();
  const dead = (selfStatus & SS_DEAD) !== 0 || phase !== "playing";
  for (const h of history) {
    stepPlayerController(gw, selfBody, predState, h.cmd, { locked: dead });
    gw.world.step(1 / TICK_RATE);
  }
  readChar(selfBody, predState);

  const after = selfBody.translation();
  const dx = before.x - after.x;
  const dy = before.y - after.y;
  const dz = before.z - after.z;
  if (Math.hypot(dx, dy, dz) > 0.03) rollbacks++;
  errOffset.x += dx;
  errOffset.y += dy;
  errOffset.z += dz;
  if (errOffset.length() > 3) errOffset.set(0, 0, 0);
}

function syncGhosts(snap: Snapshot): void {
  if (!gw) return;
  const seen = new Set<number>();
  for (const r of snap.remotes) {
    if ((r.flags & RF_DEAD) !== 0) continue; // dead bodies don't collide
    seen.add(r.idx);
    let body = ghostBodies.get(r.idx);
    if (!body) {
      body = createPlayerBody(gw, 1000 + r.idx, [r.x, r.y, r.z], { kinematic: true });
      ghostBodies.set(r.idx, body);
    }
    body.setTranslation([r.x, r.y + PLAYER_HALF_HEIGHT, r.z]);
    body.setLinearVelocity(0, 0, 0);
  }
  for (const [idx, body] of ghostBodies) {
    if (!seen.has(idx)) {
      gw.world.removeBody(body);
      gw.players.delete(1000 + idx);
      ghostBodies.delete(idx);
    }
  }
}

function syncGrenades(snap: Snapshot): void {
  if (!gw) return;
  const seen = new Set<number>();
  for (const e of snap.entities) {
    seen.add(e.id);
    const body = gw.grenades.get(e.id);
    if (!body) createGrenadeBody(gw, e.id, [e.x, e.y, e.z], [e.vx, e.vy, e.vz]);
    else {
      body.setTranslation([e.x, e.y, e.z]);
      body.setLinearVelocity(e.vx, e.vy, e.vz);
    }
  }
  for (const id of gw.grenades.keys()) {
    if (!seen.has(id)) removeGrenadeBody(gw, id);
  }
}

// --- Prediction loop.

let connected = false;
let tickAccum = 0;
let lastFrameAt = performance.now();

function predictionTick(): void {
  if (!connected || needHardAdopt || !predState || !gw || !selfBody) return;
  seq++;
  const cmd = sampleInput(seq);
  const dead = (selfStatus & SS_DEAD) !== 0 || phase !== "playing";

  const ammoBefore = predState.ammo;
  const reloadBefore = predState.reloadTicks;
  stepPlayerController(gw, selfBody, predState, cmd, {
    locked: dead,
    onFire: () => {
      sounds.shot();
      recoil = Math.min(1, recoil + 0.4);
    },
    onMelee: () => {
      sounds.melee();
      meleeSwing = 1;
    },
    onGrenade: () => blip(380, 0.08, 0.1),
    // Build is server-validated; the predicted supply decrement shows in the
    // HUD instantly and reconciles if the server refunds it.
    onBuild: () => {},
  });
  gw.world.step(1 / TICK_RATE);
  readChar(selfBody, predState);
  if (reloadBefore === 0 && predState.reloadTicks > 0 && ammoBefore < 30) sounds.reload();

  history.push({ seq, cmd });
  if (history.length > 240) history.shift();
  const tail = history.slice(-INPUT_REDUNDANCY).map((h) => h.cmd);
  void client.datagrams.send(encodeInputs(tail)).catch(() => {});
}

// ---------------------------------------------------------------------------
// Soldiers (blocky humanoids).

function makeSoldier(team: number, name: string): THREE.Group {
  const g = new THREE.Group();
  const color = TEAM_COLORS[team];
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.56, 0.62, 0.34),
    new THREE.MeshLambertMaterial({ color }),
  );
  body.position.y = 0.86;
  body.castShadow = true;
  const legs = new THREE.Mesh(
    new THREE.BoxGeometry(0.46, 0.55, 0.3),
    new THREE.MeshLambertMaterial({ color: 0x3c4046 }),
  );
  legs.position.y = 0.28;
  legs.castShadow = true;
  const headHolder = new THREE.Group();
  headHolder.name = "head";
  headHolder.position.y = 1.36;
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.34, 0.34),
    new THREE.MeshLambertMaterial({ color: 0xd9b38c }),
  );
  head.position.y = 0.17;
  head.castShadow = true;
  const helmet = new THREE.Mesh(
    new THREE.BoxGeometry(0.38, 0.14, 0.38),
    new THREE.MeshLambertMaterial({ color }),
  );
  helmet.position.y = 0.36;
  const gun = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.12, 0.75),
    new THREE.MeshLambertMaterial({ color: 0x23262b }),
  );
  gun.position.set(0.2, -0.28, 0.35);
  headHolder.add(head, helmet, gun);
  g.add(body, legs, headHolder);

  // Name tag.
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 56;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "bold 30px Trebuchet MS, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,.6)";
  ctx.strokeText(name, 128, 28);
  ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  ctx.fillText(name, 128, 28);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }),
  );
  sprite.scale.set(1.7, 0.37, 1);
  sprite.position.y = 1.95;
  g.add(sprite);

  scene.add(g);
  return g;
}

function dropRemote(idx: number): void {
  const rp = remotes.get(idx);
  if (rp) scene.remove(rp.group);
  remotes.delete(idx);
  if (gw) {
    const body = ghostBodies.get(idx);
    if (body) {
      gw.world.removeBody(body);
      gw.players.delete(1000 + idx);
      ghostBodies.delete(idx);
    }
  }
}

// ---------------------------------------------------------------------------
// View model (first-person rifle) + build preview.

const viewModel = new THREE.Group();
{
  const dark = new THREE.MeshLambertMaterial({ color: 0x23262b });
  const wood = new THREE.MeshLambertMaterial({ color: 0x4d4338 });
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.55), dark);
  barrel.position.set(0, 0.01, -0.34);
  const bodyM = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 0.3), wood);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.07), wood);
  grip.position.set(0, -0.11, 0.08);
  viewModel.add(barrel, bodyM, grip);
  viewModel.position.set(0.24, -0.22, -0.45);
  camera.add(viewModel);
}
scene.add(camera);
let recoil = 0;
let meleeSwing = 0;

const buildPreview = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshLambertMaterial({ color: 0x7d8a96, transparent: true, opacity: 0.4 }),
);
buildPreview.visible = false;
scene.add(buildPreview);

// ---------------------------------------------------------------------------
// Effects: tracers, explosions, debris, sparks.

interface Effect {
  obj: THREE.Object3D;
  until: number;
  vel?: THREE.Vector3;
  spin?: THREE.Vector3;
}
const effects: Effect[] = [];

function addEffect(
  obj: THREE.Object3D,
  lifeMs: number,
  vel?: THREE.Vector3,
  spin?: THREE.Vector3,
): void {
  scene.add(obj);
  effects.push({ obj, until: performance.now() + lifeMs, vel, spin });
}

const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8 });

function spawnTracer(from: THREE.Vector3, to: THREE.Vector3): void {
  const dir = to.clone().sub(from);
  const len = dir.length();
  if (len < 0.5) return;
  const geo = new THREE.BoxGeometry(0.025, 0.025, len);
  const mesh = new THREE.Mesh(geo, tracerMat);
  mesh.position.copy(from).add(dir.clone().multiplyScalar(0.5));
  mesh.lookAt(to);
  addEffect(mesh, 70);
}

function spawnExplosion(at: THREE.Vector3): void {
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xffb03a, transparent: true, opacity: 0.9 }),
  );
  ball.position.copy(at);
  ball.userData.grow = true;
  addEffect(ball, 240);
  spawnDebris(at, 10);
  sounds.explosion();
  if (predState) {
    const d = at.distanceTo(new THREE.Vector3(predState.x, predState.y + 1, predState.z));
    if (d < 12) shake = Math.min(1, shake + (1 - d / 12));
  }
}

function spawnDebris(at: THREE.Vector3, count: number): void {
  for (let i = 0; i < count; i++) {
    const s = 0.1 + Math.random() * 0.2;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), MAT.debris);
    mesh.position.set(
      at.x + (Math.random() - 0.5) * 0.8,
      at.y + (Math.random() - 0.5) * 0.8,
      at.z + (Math.random() - 0.5) * 0.8,
    );
    mesh.castShadow = true;
    addEffect(
      mesh,
      900 + Math.random() * 600,
      new THREE.Vector3(
        (Math.random() - 0.5) * 5,
        2 + Math.random() * 4,
        (Math.random() - 0.5) * 5,
      ),
      new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8),
    );
  }
}

function spawnSpark(at: THREE.Vector3, color = 0xffd27a): void {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 6, 4),
    new THREE.MeshBasicMaterial({ color }),
  );
  mesh.position.copy(at);
  addEffect(mesh, 120);
}

let shake = 0;

function stepEffects(dt: number): void {
  const now = performance.now();
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    if (now > e.until) {
      scene.remove(e.obj);
      if (
        e.obj instanceof THREE.Mesh &&
        e.obj.material !== MAT.debris &&
        e.obj.material !== tracerMat
      ) {
        e.obj.geometry.dispose();
        (e.obj.material as THREE.Material).dispose();
      } else if (e.obj instanceof THREE.Mesh) {
        e.obj.geometry.dispose();
      }
      effects.splice(i, 1);
      continue;
    }
    if (e.vel) {
      e.vel.y -= 12 * dt;
      e.obj.position.addScaledVector(e.vel, dt);
      if (e.obj.position.y < 0.05) {
        e.obj.position.y = 0.05;
        e.vel.y *= -0.3;
        e.vel.x *= 0.7;
        e.vel.z *= 0.7;
      }
    }
    if (e.spin) {
      e.obj.rotation.x += e.spin.x * dt;
      e.obj.rotation.y += e.spin.y * dt;
    }
    if (e.obj.userData.grow) {
      const m = e.obj as THREE.Mesh;
      m.scale.multiplyScalar(1 + dt * 9);
      (m.material as THREE.MeshBasicMaterial).opacity *= 1 - dt * 5;
    }
  }
}

// --- Transient event processing (from the snapshot ring). ---

let lastSelfTracerSeq = -1;

function processEvents(list: GameEvent[]): void {
  for (const e of list) {
    const delta = (e.seq - lastEventSeq + 0x10000) % 0x10000;
    if (delta === 0 || delta > 0x8000) continue; // old or duplicate
    lastEventSeq = e.seq;
    const at = new THREE.Vector3(e.x, e.y, e.z);
    switch (e.kind) {
      case EV_TRACER: {
        const from = eyeOf(e.a);
        if (from) spawnTracer(from, at);
        if (e.a === selfIdx) lastSelfTracerSeq = e.seq;
        if (e.a !== selfIdx && predState) {
          const d = at.distanceTo(new THREE.Vector3(predState.x, predState.y, predState.z));
          sounds.shotFar(d);
        }
        break;
      }
      case EV_HIT_PLAYER: {
        spawnSpark(at, 0xff4a3a);
        if (e.a === selfIdx) {
          el.vignette.style.opacity = "1";
          setTimeout(() => (el.vignette.style.opacity = "0"), 180);
          sounds.hurt();
        } else if (
          lastSelfTracerSeq >= 0 &&
          (e.seq - lastSelfTracerSeq + 0x10000) % 0x10000 === 1
        ) {
          // Our tracer's companion hit event: confirmed hit.
          el.hitmark.style.opacity = "1";
          setTimeout(() => (el.hitmark.style.opacity = "0"), 140);
          sounds.hitmarker();
        }
        break;
      }
      case EV_EXPLOSION:
        spawnExplosion(at);
        break;
      case EV_PANEL_HIT:
        spawnSpark(at);
        break;
      case EV_MELEE:
        spawnSpark(at, 0xcccccc);
        break;
    }
  }
}

function eyeOf(idx: number): THREE.Vector3 | null {
  if (idx === selfIdx) {
    return predState ? new THREE.Vector3(predState.x, predState.y + EYE_HEIGHT, predState.z) : null;
  }
  const rp = remotes.get(idx);
  if (!rp || rp.buffer.length === 0) return null;
  const last = rp.buffer[rp.buffer.length - 1];
  return new THREE.Vector3(last.x, last.y + EYE_HEIGHT, last.z);
}

// --- Grenade views.

const grenadeViews = new Map<number, THREE.Mesh>();

function updateGrenadeViews(snap: Snapshot): void {
  const seen = new Set<number>();
  for (const e of snap.entities) {
    seen.add(e.id);
    if (!grenadeViews.has(e.id)) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 10, 8),
        new THREE.MeshLambertMaterial({ color: 0x2f5e2f }),
      );
      mesh.castShadow = true;
      scene.add(mesh);
      grenadeViews.set(e.id, mesh);
    }
  }
  for (const [id, mesh] of grenadeViews) {
    if (!seen.has(id)) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      grenadeViews.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Frame loop.

function frame(): void {
  requestAnimationFrame(frame);
  const now = performance.now();
  let dt = (now - lastFrameAt) / 1000;
  lastFrameAt = now;
  if (dt > 0.25) dt = 0.25;

  const rate = 1 + Math.max(-0.06, Math.min(0.06, (TARGET_DEPTH - depthEma) * 0.025));
  tickAccum += dt * 1000 * rate;
  let steps = 0;
  while (tickAccum >= TICK_MS && steps < 6) {
    tickAccum -= TICK_MS;
    predictionTick();
    steps++;
  }
  if (steps === 6) tickAccum = 0;

  errOffset.multiplyScalar(Math.exp(-dt * 12));
  recoil *= Math.exp(-dt * 10);
  shake *= Math.exp(-dt * 5);
  if (meleeSwing > 0) meleeSwing = Math.max(0, meleeSwing - dt * 4);

  // Camera at the predicted eye.
  if (predState) {
    const dead = (selfStatus & SS_DEAD) !== 0;
    camera.position.set(
      predState.x + errOffset.x + (Math.random() - 0.5) * shake * 0.12,
      predState.y + errOffset.y + (dead ? 0.4 : EYE_HEIGHT) + (Math.random() - 0.5) * shake * 0.1,
      predState.z + errOffset.z,
    );
    camera.rotation.order = "YXZ";
    camera.rotation.y = yaw + Math.PI;
    camera.rotation.x = -pitch + recoil * 0.045;
    camera.rotation.z = 0;
  }
  viewModel.position.set(
    0.24,
    -0.22 - meleeSwing * 0.12,
    -0.45 + recoil * 0.06 + meleeSwing * -0.25,
  );
  viewModel.rotation.x = recoil * 0.25 + meleeSwing * 0.9;
  viewModel.visible = (selfStatus & SS_DEAD) === 0;

  // Build preview while holding Q-able state (always shown when alive + supply).
  if (predState && (selfStatus & SS_DEAD) === 0 && keys.has("KeyQ") && predState.supply > 0) {
    const placement = buildPlacement(predState, yaw);
    const [w, h, d] = panelExtents(placement.orient);
    buildPreview.scale.set(w, h, d);
    buildPreview.position.set(placement.x, placement.y, placement.z);
    buildPreview.visible = true;
  } else {
    buildPreview.visible = false;
  }

  // Remotes (interpolated in the past).
  const renderT = now - REMOTE_DELAY_MS;
  for (const rp of remotes.values()) {
    if (rp.buffer.length === 0) continue;
    const buf = rp.buffer;
    let a = buf[0];
    let b = buf[buf.length - 1];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= renderT) {
        a = buf[i];
        b = buf[Math.min(i + 1, buf.length - 1)];
        break;
      }
    }
    const span2 = Math.max(1, b.t - a.t);
    const u = Math.max(0, Math.min(1, (renderT - a.t) / span2));
    rp.group.position.set(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u);
    const dyaw = shortestArc(a.yaw, b.yaw);
    rp.group.rotation.y = a.yaw + dyaw * u + Math.PI;
    const head = rp.group.getObjectByName("head");
    if (head) head.rotation.x = -(a.pitch + (b.pitch - a.pitch) * u);
    const dead = (rp.lastFlags & RF_DEAD) !== 0;
    rp.group.visible = !dead;
    const prot = (rp.lastFlags & RF_PROTECTED) !== 0;
    rp.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshLambertMaterial) {
        o.material.transparent = prot;
        o.material.opacity = prot ? 0.55 : 1;
      }
    });
  }

  // Grenades render from the mirror world bodies.
  if (gw) {
    for (const [id, mesh] of grenadeViews) {
      const body = gw.grenades.get(id);
      if (body) {
        const pos = body.translation();
        const rot = body.rotation();
        mesh.position.set(pos.x, pos.y, pos.z);
        mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
      }
    }
  }

  stepEffects(dt);
  updateHud();
  renderer.render(scene, camera);
}

function shortestArc(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// --- HUD updates.

function updateHud(): void {
  el.scores.innerHTML = `<span style="color:${TEAM_COLORS_CSS[0]}">${scores[0]}</span> · <span style="color:${TEAM_COLORS_CSS[1]}">${scores[1]}</span>`;
  const ticksLeft = Math.max(0, phaseEndTick - estServerTick());
  const secs = Math.ceil(ticksLeft / TICK_RATE);
  el.timer.textContent =
    phase === "playing" ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : "";

  (el.hpfill as HTMLElement).style.width = `${Math.max(0, (selfHp / MAX_HP) * 100)}%`;
  (el.hpfill as HTMLElement).style.background =
    selfHp > 50 ? "#5ad05a" : selfHp > 25 ? "#d0b54a" : "#d05a4a";
  if (predState) {
    el.ammotext.textContent = predState.reloadTicks > 0 ? "…" : `${predState.ammo}`;
    el.gear.textContent = `🧨 ${predState.grenades}  🧱 ${predState.supply}`;
  }

  const dead = (selfStatus & SS_DEAD) !== 0;
  if (phase === "results") {
    const winner =
      scores[0] === scores[1] ? "Draw" : `${TEAM_NAMES[scores[0] > scores[1] ? 0 : 1]} wins`;
    el.overlaypanel.innerHTML = `<h1>${winner}</h1><p>${scores[0]} — ${scores[1]}</p><p>next round starting…</p>`;
    el.overlay.style.display = "flex";
  } else if (dead) {
    el.overlaypanel.innerHTML = `<h1>You're down</h1><p>respawn in ${Math.ceil(respawnTicks / TICK_RATE)}s</p>`;
    el.overlay.style.display = "flex";
  } else if (!connected) {
    el.overlaypanel.innerHTML = `<h1>Breachpoint</h1><p>connecting…</p>`;
    el.overlay.style.display = "flex";
  } else {
    el.overlay.style.display = "none";
  }

  if (keys.has("Tab")) {
    const rows = [...roster.values()]
      .map((p) => ({ p, s: kd.get(p.idx) ?? { k: 0, d: 0 } }))
      .sort((a, b) => b.s.k - a.s.k)
      .map(
        ({ p, s }) =>
          `<tr><td style="color:${TEAM_COLORS_CSS[p.team]}">${escapeHtml(p.name)}${p.idx === selfIdx ? " (you)" : ""}</td><td>${s.k}</td><td>${s.d}</td></tr>`,
      )
      .join("");
    el.board.innerHTML = `<table><tr><th>player</th><th>K</th><th>D</th></tr>${rows}</table>`;
    el.board.style.display = "block";
  } else {
    el.board.style.display = "none";
  }

  const rtt = client.net.rtt;
  el.netinfo.textContent = `rtt ${rtt === null ? "—" : Math.round(rtt)}ms · rollbacks ${rollbacks}`;
}

// ---------------------------------------------------------------------------
// Boot.

async function boot(): Promise<void> {
  buildMapVisuals();
  void readStreams();
  void readDatagrams();
  frame();
  try {
    await client.ready;
    connected = true;
  } catch {
    return;
  }
  void client.closed.then(() => {
    connected = false;
  });
}

void boot();

// ---------------------------------------------------------------------------
// Dev hooks for the playtest scripts.

declare global {
  interface Window {
    __fps: {
      connectionState(): string;
      playerPosition(): [number, number, number];
      hp(): number;
      phase(): string;
      scores(): [number, number];
      roster(): Array<{ idx: number; name: string; team: number }>;
      rollbacks(): number;
      snapshots(): number;
      seq(): number;
      selfStatus(): number;
      ammo(): number;
      panelCount(): number;
      destroyedCount(): number;
      look(yawV: number, pitchV: number): void;
      drive(over: Partial<Omit<InputCmd, "seq">>, ticks: number): void;
      stopDrive(): void;
    };
  }
}

window.__fps = {
  connectionState: () => (connected ? "connected" : "connecting"),
  playerPosition: () => (predState ? [predState.x, predState.y, predState.z] : [0, 0, 0]),
  hp: () => selfHp,
  phase: () => phase,
  scores: () => [scores[0], scores[1]],
  roster: () => [...roster.values()].map((p) => ({ idx: p.idx, name: p.name, team: p.team })),
  rollbacks: () => rollbacks,
  snapshots: () => snapshotsSeen,
  seq: () => seq,
  selfStatus: () => selfStatus,
  ammo: () => (predState ? predState.ammo : 0),
  panelCount: () => panelMeshes.size,
  destroyedCount: () => destroyedSet.size,
  look: (yawV, pitchV) => {
    yaw = yawV;
    pitch = pitchV;
  },
  drive: (over, ticks) => {
    driven = { ...ZERO_INPUT, yaw, pitch, ...over, ticks };
  },
  stopDrive: () => {
    driven = null;
  },
};

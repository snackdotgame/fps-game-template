import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const assetsDir = path.join(projectRoot, "assets");
const snackClientEntryId = "/snack/client-entry";
const snackClientModuleId = "snack:client";
const userClientEntryId = "/src/client.ts";
const resolvedSnackClientEntryId = `\0${snackClientEntryId}`;
const resolvedSnackClientModuleId = `\0${snackClientModuleId}`;
const clientDevHost = process.env.SNACK_CLIENT_HOST ?? "127.0.0.1";
// port resolution matches `snack dev`: env > snack.json dev.clientPort > 3031
const clientDevPort = portFromEnv("SNACK_CLIENT_PORT", manifestDevClientPort() ?? 3031);

// the optional `dev` section of snack.json configures local ports:
//   "dev": { "port": 3030, "clientPort": 3031 }
function manifestDevClientPort(): number | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path.join(projectRoot, "snack.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof manifest !== "object" || manifest === null) {
    return undefined;
  }
  const dev = (manifest as Record<string, unknown>).dev;
  if (typeof dev !== "object" || dev === null) {
    return undefined;
  }
  const port = (dev as Record<string, unknown>).clientPort;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return port;
}

function portFromEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue === "") {
    return fallback;
  }

  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return port;
}

function snackClientRuntime(): Plugin {
  return {
    name: "snack-client-runtime",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace(
          /<script\s+type=["']module["']\s+src=["']\/src\/client\.ts["']><\/script>/,
          `<script type="module" src="${snackClientEntryId}"></script>`,
        );
      },
    },
    resolveId(id) {
      if (id === snackClientEntryId) {
        return resolvedSnackClientEntryId;
      }
      if (id === snackClientModuleId) {
        return resolvedSnackClientModuleId;
      }
      return null;
    },
    load(id) {
      if (id === resolvedSnackClientEntryId) {
        return [
          `import { startSnackClientRuntime } from ${JSON.stringify(snackClientModuleId)};`,
          "await startSnackClientRuntime();",
          `await import(${JSON.stringify(userClientEntryId)});`,
          "",
        ].join("\n");
      }
      if (id === resolvedSnackClientModuleId) {
        return SNACK_CLIENT_RUNTIME_SOURCE;
      }
      return null;
    },
  };
}

async function assertNoAssetSymlinks(root: string, current = root): Promise<void> {
  const stat = await fs.lstat(current);
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Asset path is a symlink and cannot be served or bundled: ${path.relative(root, current) || "."}`,
    );
  }
  if (!stat.isDirectory()) {
    return;
  }

  for (const entry of await fs.readdir(current)) {
    await assertNoAssetSymlinks(root, path.join(current, entry));
  }
}

function snackAssets(): Plugin {
  return {
    name: "snack-assets",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        try {
          const pathname = new URL(request.url ?? "/", "http://snack.local").pathname;
          if (!pathname.startsWith("/assets/")) {
            next();
            return;
          }

          const assetPath = decodeURIComponent(pathname.slice("/assets/".length));
          const candidate = path.resolve(assetsDir, assetPath);
          const relativePath = path.relative(assetsDir, candidate);

          if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
            response.statusCode = 403;
            response.end("Forbidden");
            return;
          }

          const stat = await fs.lstat(candidate);
          if (stat.isSymbolicLink()) {
            response.statusCode = 403;
            response.end("Forbidden");
            return;
          }
          if (!stat.isFile()) {
            next();
            return;
          }

          response.setHeader("Content-Type", contentTypeFor(candidate));
          response.end(await fs.readFile(candidate));
        } catch (error) {
          if (isNotFound(error)) {
            next();
            return;
          }
          next(error);
        }
      });
    },
    async writeBundle(options) {
      const outputDir =
        typeof options.dir === "string" ? options.dir : path.join(projectRoot, "dist/client");
      await assertNoAssetSymlinks(assetsDir);
      await fs.cp(assetsDir, path.join(outputDir, "assets"), {
        recursive: true,
        force: true,
      });
    },
  };
}

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".svg") {
    return "image/svg+xml";
  }

  if (extension === ".json") {
    return "application/json";
  }

  if (extension === ".txt") {
    return "text/plain; charset=utf-8";
  }

  if (extension === ".md") {
    return "text/markdown; charset=utf-8";
  }

  if (extension === ".wasm") {
    return "application/wasm";
  }

  if (extension === ".gltf") {
    return "model/gltf+json";
  }

  if (extension === ".glb") {
    return "model/gltf-binary";
  }

  if (extension === ".bin") {
    return "application/octet-stream";
  }

  if (extension === ".ktx2") {
    return "image/ktx2";
  }

  if (extension === ".hdr") {
    return "image/vnd.radiance";
  }

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }

  if (extension === ".webp") {
    return "image/webp";
  }

  if (extension === ".gif") {
    return "image/gif";
  }

  if (extension === ".mp3") {
    return "audio/mpeg";
  }

  if (extension === ".ogg") {
    return "audio/ogg";
  }

  if (extension === ".wav") {
    return "audio/wav";
  }

  return "application/octet-stream";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export default defineConfig({
  server: {
    host: clientDevHost,
    port: clientDevPort,
    strictPort: true,
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  plugins: [snackClientRuntime(), snackAssets()],
});

const SNACK_CLIENT_RUNTIME_SOURCE = String.raw`
const READY_MESSAGE = Object.freeze({ type: "snack.ready", version: 1 });
const STREAM_KIND_CONTROL = 0;
const STREAM_KIND_MESSAGE = 1;
const STREAM_KIND_CHAT = 2;
const CHAT_PROTOCOL_VERSION = 1;
const CHAT_OPCODE_SEND = 0;
const CHAT_OPCODE_MESSAGE = 1;
const LAUNCH_TIMEOUT_MS = 15000;
const NETWORK_RTT_PING_INTERVAL_MS = 1000;
const MAX_PENDING_RTT_SAMPLES = 32;
const RTT_EMA_ALPHA = 0.1;
const RTT_JITTER_EMA_ALPHA = 1 / 16;
const MAX_DATAGRAM_BYTES = 65536;
const MAX_STREAM_BYTES = 1048576;
const MAX_CHAT_FRAME_BYTES = 4096;
const MAX_CHAT_PAYLOAD_BYTES = 2048;
const MAX_CHAT_TEXT_SCALARS = 500;
const MAX_QUEUED_MESSAGES = 1024;
const DATAGRAM_COMPATIBILITY_ERROR = "This browser does not expose the WebTransport datagram API required by Snack.Game. Update your browser or use a current Safari, Chrome, Edge, or Firefox build with WebTransport datagram support.";

const runtime = createRuntime();
const datagramWritables = new WeakMap();

export const client = runtime.client;

export function startSnackClientRuntime() {
  return runtime.started;
}

function createRuntime() {
  const networkStats = createNetworkStats();
  const transportReady = deferred();
  const launchReady = deferred();
  const connectionReady = deferred();
  const chatCapabilityReady = deferred();
  const publicReady = transportReady.promise.then(() => undefined);
  const closed = transportReady.promise.then(
    (transport) => transport.closed.then(() => undefined, () => undefined),
    () => undefined,
  );
  const datagrams = createClientChannel({ maxSize: MAX_DATAGRAM_BYTES }, (payload) => {
    return sendDatagram(transportReady.promise, payload);
  });
  const streams = createClientChannel({ maxSize: MAX_STREAM_BYTES }, (payload) => {
    return sendStream(transportReady.promise, payload);
  });
  const chat = createClientChannel({
    maxTextLength: MAX_CHAT_TEXT_SCALARS,
    maxStructuredPayloadBytes: MAX_CHAT_PAYLOAD_BYTES,
  }, (payload) => {
    return sendChat(transportReady.promise, chatCapabilityReady.promise, payload);
  });

  const client = Object.freeze({
    launch: launchReady.promise,
    connection: connectionReady.promise,
    net: networkStats.view,
    ready: publicReady,
    closed,
    chat: chat.channel,
    datagrams: datagrams.channel,
    streams: streams.channel,
  });

  void closed.then(() => {
    const error = new Error("Snack client connection closed");
    chatCapabilityReady.resolve(false);
    datagrams.close(error);
    streams.close(error);
    chat.close(error);
  });
  void connect({
    datagrams,
    chat,
    streams,
    networkStats,
    transportReady,
    launchReady,
    connectionReady,
    chatCapabilityReady,
  });

  return {
    client,
    started: Promise.resolve(),
  };
}

async function connect(state) {
  try {
    if (!("WebTransport" in globalThis)) {
      throw new Error("WebTransport is not available in this browser");
    }

    const connectInfo = await resolveConnectInfo(state.launchReady);
    const transport = new WebTransport(connectInfo.url, {
      requireUnreliable: true,
      serverCertificateHashes: connectInfo.serverCertificateHashes.map((hash) => ({
        algorithm: hash.algorithm,
        value: Uint8Array.from(hash.value),
      })),
    });

    void readStreams(
      transport,
      state.streams,
      state.chat,
      state.connectionReady,
      state.chatCapabilityReady,
      transport,
      state.networkStats,
    ).catch(reportRuntimeError);
    void readBidirectionalStreams(
      transport,
      state.streams,
      state.chat,
      state.connectionReady,
      state.chatCapabilityReady,
      transport,
      state.networkStats,
    ).catch(reportRuntimeError);

    await transport.ready;
    assertUnreliableTransportAvailable(transport);
    assertDatagramsAvailable(transport);
    void readDatagrams(transport, state.datagrams).catch(reportRuntimeError);
    state.transportReady.resolve(transport);
    void sampleNetworkRtt(transport, state.networkStats).catch(reportRuntimeError);
  } catch (error) {
    state.launchReady.reject(error);
    state.transportReady.reject(error);
    state.connectionReady.reject(error);
    state.chatCapabilityReady.resolve(false);
    reportRuntimeStartupError(error);
  }
}

async function resolveConnectInfo(launchReady) {
  const launch = await waitForLaunchEnvelope(LAUNCH_TIMEOUT_MS);
  launchReady.resolve(launch);
  return launch.transport;
}

function waitForLaunchEnvelope(timeoutMs) {
  if (window.parent === window) {
    return Promise.reject(new Error("Snack launch envelope is required"));
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onLaunchMessage);
      reject(new Error("Snack launch envelope timed out"));
    }, timeoutMs);

    function onLaunchMessage(event) {
      if (event.source !== window.parent || !isLaunchEnvelope(event.data)) {
        return;
      }

      window.clearTimeout(timeout);
      window.removeEventListener("message", onLaunchMessage);
      resolve(event.data);
    }

    window.addEventListener("message", onLaunchMessage);
    window.parent.postMessage(READY_MESSAGE, "*");
  });
}

function isLaunchEnvelope(value) {
  if (!isRecord(value)) {
    return false;
  }

  return value.type === "snack.launch"
    && value.version === 1
    && typeof value.launchId === "string"
    && isRecord(value.user)
    && isRecord(value.game)
    && isConnectInfo(value.transport);
}

function isConnectInfo(value) {
  return isRecord(value)
    && value.type === "webtransport"
    && typeof value.url === "string"
    && Array.isArray(value.serverCertificateHashes)
    && value.serverCertificateHashes.every(isCertificateHash);
}

function isCertificateHash(value) {
  return isRecord(value)
    && value.algorithm === "sha-256"
    && Array.isArray(value.value)
    && value.value.length === 32
    && value.value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}

function createNetworkStats() {
  const state = {
    nextPingId: 0,
    pendingPings: new Map(),
    rtt: null,
    latestRtt: null,
    jitter: null,
  };

  return {
    view: Object.freeze({
      get rtt() {
        return state.rtt;
      },
      get latestRtt() {
        return state.latestRtt;
      },
      get jitter() {
        return state.jitter;
      },
    }),
    nextPingId() {
      state.nextPingId = state.nextPingId >= Number.MAX_SAFE_INTEGER
        ? 1
        : state.nextPingId + 1;
      return state.nextPingId;
    },
    recordPing(pingId, now) {
      if (state.pendingPings.size === MAX_PENDING_RTT_SAMPLES) {
        const oldestPingId = state.pendingPings.keys().next().value;
        state.pendingPings.delete(oldestPingId);
      }
      state.pendingPings.set(pingId, now);
    },
    recordPong(pingId, now) {
      const sentAt = state.pendingPings.get(pingId);
      if (typeof sentAt !== "number") {
        return;
      }
      state.pendingPings.delete(pingId);
      const latestRtt = now - sentAt;
      if (!Number.isFinite(latestRtt) || latestRtt < 0) {
        return;
      }
      const previousLatestRtt = state.latestRtt;
      state.latestRtt = latestRtt;
      state.rtt = state.rtt == null
        ? latestRtt
        : RTT_EMA_ALPHA * latestRtt + (1 - RTT_EMA_ALPHA) * state.rtt;
      if (previousLatestRtt != null) {
        const variation = Math.abs(latestRtt - previousLatestRtt);
        state.jitter = state.jitter == null
          ? variation
          : state.jitter + RTT_JITTER_EMA_ALPHA * (variation - state.jitter);
      }
    },
  };
}

// Keep-alive pings must keep flowing while the tab is backgrounded: page
// timers throttle to once a minute under intensive throttling, but worker
// timers and worker message delivery are exempt, so the ping cadence comes
// from a Worker. Falls back to page timers when workers are unavailable
// (e.g. a worker-src CSP).
function createPingTicker(intervalMs) {
  try {
    const source = "setInterval(() => postMessage(0), " + intervalMs + ");";
    // the URL must outlive worker startup (it is fetched asynchronously);
    // it is revoked in stop()
    const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
    const worker = new Worker(url);
    let workerFailed = false;
    worker.addEventListener("error", () => {
      workerFailed = true;
    });
    return {
      next() {
        if (workerFailed) {
          return sleep(intervalMs);
        }
        return new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          worker.addEventListener("message", finish, { once: true });
          // a silently-dead worker must never stall the ping loop; this
          // page timer may be throttled, which only degrades cadence
          window.setTimeout(finish, intervalMs * 4);
        });
      },
      stop() {
        worker.terminate();
        URL.revokeObjectURL(url);
      },
    };
  } catch {
    return {
      next() {
        return sleep(intervalMs);
      },
      stop() {},
    };
  }
}

async function sampleNetworkRtt(transport, networkStats) {
  const closed = transport.closed.then(() => true, () => true);
  const ticker = createPingTicker(NETWORK_RTT_PING_INTERVAL_MS);

  try {
    while (true) {
      const pingId = networkStats.nextPingId();
      await sendControlMessage(transport, { type: "ping", id: pingId });
      networkStats.recordPing(pingId, performance.now());
      const isClosed = await Promise.race([
        ticker.next().then(() => false),
        closed,
      ]);
      if (isClosed) {
        return;
      }
    }
  } finally {
    ticker.stop();
  }
}

async function sendDatagram(transportReady, payload) {
  const bytes = toBytes(payload);
  assertPayloadSize(bytes, MAX_DATAGRAM_BYTES);
  const transport = await transportReady;
  const writable = getDatagramWritable(transport);
  if (writable == null) {
    throw datagramCompatibilityError();
  }

  assertDatagramSize(transport, bytes);
  const writer = writable.getWriter();
  try {
    await writer.ready;
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
}

function assertUnreliableTransportAvailable(transport) {
  if (transport.reliability === "reliable-only") {
    throw datagramCompatibilityError();
  }
}

function assertDatagramsAvailable(transport) {
  if (!hasReadableDatagrams(transport) || getDatagramWritable(transport) == null) {
    throw datagramCompatibilityError();
  }
}

function getDatagramWritable(transport) {
  const datagrams = transport.datagrams;
  if (datagrams == null) {
    return null;
  }

  const cached = datagramWritables.get(datagrams);
  if (cached != null) {
    return cached;
  }

  if (typeof datagrams.createWritable === "function") {
    const writable = datagrams.createWritable();
    if (writable != null && typeof writable.getWriter === "function") {
      datagramWritables.set(datagrams, writable);
      return writable;
    }
  }

  if (datagrams.writable != null && typeof datagrams.writable.getWriter === "function") {
    return datagrams.writable;
  }

  return null;
}

function assertDatagramSize(transport, bytes) {
  const maxDatagramSize = transport.datagrams?.maxDatagramSize;
  if (
    Number.isInteger(maxDatagramSize)
    && maxDatagramSize > 0
    && bytes.byteLength > maxDatagramSize
  ) {
    throw new RangeError(
      "WebTransport datagram payload is "
        + bytes.byteLength
        + " bytes, exceeding maxDatagramSize "
        + maxDatagramSize,
    );
  }
}

function hasReadableDatagrams(transport) {
  const datagrams = transport.datagrams;
  return datagrams != null
    && datagrams.readable != null
    && typeof datagrams.readable.getReader === "function";
}

async function sendControlMessage(transport, message) {
  await sendFramedStream(transport, STREAM_KIND_CONTROL, textEncoder().encode(JSON.stringify(message)));
}

async function sendStream(transportReady, payload) {
  const bytes = toBytes(payload);
  assertPayloadSize(bytes, MAX_STREAM_BYTES);
  const transport = await transportReady;
  await sendFramedStream(transport, STREAM_KIND_MESSAGE, bytes);
}

async function sendChat(transportReady, chatCapabilityReady, payload) {
  const validatedPayload = validateChatPayload(payload);
  const bytes = textEncoder().encode(JSON.stringify([
    CHAT_PROTOCOL_VERSION,
    CHAT_OPCODE_SEND,
    validatedPayload,
  ]));
  assertPayloadSize(bytes, MAX_CHAT_FRAME_BYTES);
  const transport = await transportReady;
  if (!(await chatCapabilityReady)) {
    throw new Error("This Snack host does not support chat protocol version 1");
  }
  await sendFramedStream(transport, STREAM_KIND_CHAT, bytes);
}

async function sendFramedStream(transport, kind, bytes) {
  if (typeof transport.createUnidirectionalStream !== "function") {
    throw new Error("WebTransport unidirectional streams are not available in this browser");
  }

  const stream = await transport.createUnidirectionalStream();
  const writer = stream.getWriter();
  try {
    await writer.ready;
    await writer.write(framePayload(kind, bytes));
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

async function readDatagrams(transport, channel) {
  if (!hasReadableDatagrams(transport)) {
    return;
  }

  const reader = transport.datagrams.readable.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      if (!(await channel.enqueue(messageEvent("datagram", result.value)))) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function readStreams(
  transport,
  streamChannel,
  chatChannel,
  connectionReady,
  chatCapabilityReady,
  controlTransport,
  networkStats,
) {
  if (!transport.incomingUnidirectionalStreams) {
    return;
  }

  const reader = transport.incomingUnidirectionalStreams.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      const shouldContinue = await readStream(
        result.value,
        streamChannel,
        chatChannel,
        connectionReady,
        chatCapabilityReady,
        controlTransport,
        networkStats,
      );
      if (!shouldContinue) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function readBidirectionalStreams(
  transport,
  streamChannel,
  chatChannel,
  connectionReady,
  chatCapabilityReady,
  controlTransport,
  networkStats,
) {
  if (!transport.incomingBidirectionalStreams) {
    return;
  }

  const reader = transport.incomingBidirectionalStreams.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      const shouldContinue = await readStream(
        result.value.readable,
        streamChannel,
        chatChannel,
        connectionReady,
        chatCapabilityReady,
        controlTransport,
        networkStats,
      );
      if (!shouldContinue) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function readStream(
  stream,
  streamChannel,
  chatChannel,
  connectionReady,
  chatCapabilityReady,
  controlTransport,
  networkStats,
) {
  const bytes = await readAllBytes(stream);
  const kind = bytes[0];
  const payload = bytes.slice(1);
  if (kind === STREAM_KIND_CONTROL) {
    handleControlMessage(
      payload,
      connectionReady,
      chatCapabilityReady,
      controlTransport,
      networkStats,
    );
    return true;
  }
  if (kind === STREAM_KIND_MESSAGE) {
    return await streamChannel.enqueue(messageEvent("stream", payload));
  }
  if (kind === STREAM_KIND_CHAT) {
    try {
      if (payload.byteLength > MAX_CHAT_FRAME_BYTES) {
        throw new RangeError("chat frame exceeds the maximum size");
      }
      return chatChannel.enqueueDroppingOldest(chatMessage(payload));
    } catch (error) {
      reportRuntimeError(error);
      return true;
    }
  }
  return true;
}

async function readAllBytes(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      chunks.push(result.value);
      byteLength += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function handleControlMessage(
  bytes,
  connectionReady,
  chatCapabilityReady,
  transport,
  networkStats,
) {
  const text = textDecoder().decode(bytes);
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  if (!isRecord(message)) {
    return;
  }

  if (message.type === "ping" && isControlMessageId(message.id)) {
    void sendControlMessage(transport, { type: "pong", id: message.id }).catch(reportRuntimeError);
    return;
  }

  if (message.type === "pong" && isControlMessageId(message.id)) {
    networkStats.recordPong(message.id, performance.now());
    return;
  }

  if (message.type !== "welcome") {
    return;
  }

  if (
    typeof message.connectionId !== "string" ||
    message.connectionId.trim().length === 0 ||
    typeof message.userId !== "string" ||
    message.userId.trim().length === 0 ||
    typeof message.userName !== "string" ||
    message.userName.trim().length === 0 ||
    typeof message.isGuest !== "boolean"
  ) {
    const error = new Error("Snack welcome message is missing required connection identity");
    reportRuntimeError(error);
    connectionReady.reject(error);
    chatCapabilityReady.resolve(false);
    try {
      transport.close({ closeCode: 1008, reason: "invalid welcome identity" });
    } catch {
      // The rejected connection promise and console error carry the failure.
    }
    return;
  }

  chatCapabilityReady.resolve(message.chatProtocolVersion === CHAT_PROTOCOL_VERSION);
  connectionReady.resolve(Object.freeze({
    connectionId: message.connectionId,
    userId: message.userId,
    userName: message.userName,
    isGuest: message.isGuest,
  }));
}

function isControlMessageId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function framePayload(kind, bytes) {
  const framed = new Uint8Array(bytes.byteLength + 1);
  framed[0] = kind;
  framed.set(bytes, 1);
  return framed;
}

function toBytes(payload) {
  if (payload instanceof Uint8Array) {
    return payload;
  }
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (payload instanceof ArrayBuffer) {
    return new Uint8Array(payload);
  }
  if (typeof payload === "string") {
    return textEncoder().encode(payload);
  }

  const json = JSON.stringify(payload);
  if (typeof json !== "string") {
    throw new TypeError("payload must be bytes, a string, or JSON-serializable");
  }
  return textEncoder().encode(json);
}

function chatMessage(bytes) {
  let frame;
  try {
    frame = JSON.parse(chatTextDecoder().decode(bytes));
  } catch {
    throw new TypeError("received chat frame is not valid JSON");
  }
  if (
    !Array.isArray(frame)
    || frame.length !== 9
    || frame[0] !== CHAT_PROTOCOL_VERSION
    || frame[1] !== CHAT_OPCODE_MESSAGE
    || typeof frame[2] !== "string"
    || frame[2].length === 0
    || !Number.isSafeInteger(frame[3])
    || frame[3] < 0
    || (frame[4] !== 0 && frame[4] !== 1)
    || !Number.isSafeInteger(frame[7])
    || frame[7] < 0
    || !Number.isSafeInteger(frame[8])
    || frame[8] < 0
  ) {
    throw new TypeError("received chat frame has an invalid shape");
  }

  const sender = frame[4] === 0 ? chatSender(frame[5]) : null;
  if (frame[4] === 1 && frame[5] !== null) {
    throw new TypeError("server chat frame must not include a player sender");
  }
  const payload = freezeChatValue(validateChatPayload(frame[6], false));
  return Object.freeze({
    messageId: frame[2],
    sequence: frame[3],
    source: frame[4] === 0 ? "player" : "server",
    sender,
    payload,
    sentAt: frame[7],
    deliveredAt: frame[8],
  });
}

function chatSender(value) {
  if (
    !isRecord(value)
    || typeof value.connectionId !== "string"
    || value.connectionId.length === 0
    || typeof value.userId !== "string"
    || value.userId.length === 0
    || typeof value.userName !== "string"
    || value.userName.length === 0
    || typeof value.isGuest !== "boolean"
  ) {
    throw new TypeError("player chat frame has an invalid sender");
  }
  return Object.freeze({
    connectionId: value.connectionId,
    userId: value.userId,
    userName: value.userName,
    isGuest: value.isGuest,
  });
}

function validateChatPayload(payload, enforcePayloadSize = true) {
  if (typeof payload !== "string" && !isPlainChatObject(payload)) {
    throw new TypeError("chat payload must be a string or JSON object");
  }
  if (typeof payload === "string" && payload.trim().length === 0) {
    throw new TypeError("chat text must not be empty");
  }

  const limits = { items: 0, keyBytes: 0, textScalars: 0 };
  const payloadBytes = validateChatValue(payload, 0, limits);
  if (enforcePayloadSize && payloadBytes > MAX_CHAT_PAYLOAD_BYTES) {
    throw new RangeError(
      "payload exceeds maximum size of " + MAX_CHAT_PAYLOAD_BYTES + " bytes",
    );
  }
  return payload;
}

function validateChatValue(value, depth, limits) {
  if (depth > 16) {
    throw new RangeError("chat payload exceeds the maximum depth");
  }
  if (value == null) {
    return 4;
  }
  if (typeof value === "boolean") {
    return value ? 4 : 5;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError("chat numbers must be finite safe JavaScript numbers");
    }
    return String(Object.is(value, -0) ? 0 : value).length;
  }
  if (typeof value === "string") {
    assertChatString(value);
    limits.textScalars += Array.from(value).length;
    if (limits.textScalars > MAX_CHAT_TEXT_SCALARS) {
      throw new RangeError("chat payload contains too much text");
    }
    return chatJsonStringByteLength(value);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 128) {
      throw new TypeError("chat arrays must be plain arrays with at most 128 items");
    }
    if (
      Object.getOwnPropertySymbols(value).length !== 0
      || Object.getOwnPropertyNames(value).length !== value.length + 1
    ) {
      throw new TypeError("chat arrays must not contain extra properties");
    }
    limits.items += value.length;
    if (limits.items > 256) {
      throw new RangeError("chat payload contains too many values");
    }
    let bytes = 2 + Math.max(0, value.length - 1);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor == null || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("chat arrays must not be sparse or contain accessors");
      }
      bytes += validateChatValue(descriptor.value, depth + 1, limits);
    }
    return bytes;
  }
  if (!isPlainChatObject(value)) {
    throw new TypeError("chat payload values must be JSON-compatible");
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError("chat values must not contain symbol keys");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length > 64) {
    throw new RangeError("chat objects must contain at most 64 properties");
  }
  limits.items += keys.length;
  if (limits.items > 256) {
    throw new RangeError("chat payload contains too many values");
  }
  let bytes = 2 + Math.max(0, keys.length - 1);
  for (const key of keys) {
    assertChatString(key);
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new TypeError("chat payload contains a reserved object key");
    }
    const keyBytes = textEncoder().encode(key).byteLength;
    limits.keyBytes += keyBytes;
    if (keyBytes > 128 || limits.keyBytes > 1024) {
      throw new RangeError("chat payload object keys are too large");
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("chat payload must contain only enumerable data properties");
    }
    bytes += chatJsonStringByteLength(key) + 1;
    bytes += validateChatValue(descriptor.value, depth + 1, limits);
  }
  return bytes;
}

function chatJsonStringByteLength(value) {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
      || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function assertChatString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("chat strings must not contain lone UTF-16 surrogates");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("chat strings must not contain lone UTF-16 surrogates");
    }
  }
}

function isPlainChatObject(value) {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeChatValue(value) {
  if (value == null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    freezeChatValue(child);
  }
  return value;
}

function messageEvent(type, bytes) {
  const eventBytes = Uint8Array.from(bytes);
  let text;
  let json;
  return Object.freeze({
    type,
    bytes: eventBytes,
    receivedAt: performance.now(),
    text() {
      text ??= textDecoder().decode(eventBytes);
      return text;
    },
    json() {
      json ??= JSON.parse(this.text());
      return json;
    },
  });
}

function createClientChannel(properties, send) {
  const state = {
    queue: [],
    recvWaiters: [],
    spaceWaiters: [],
    closeError: null,
  };
  return {
    channel: Object.freeze({
      ...properties,
      drain() {
        const events = state.queue.splice(0);
        notifyQueueSpace(state);
        return events;
      },
      drainInto(target) {
        assertDrainTarget(target);
        const events = state.queue.splice(0);
        for (const event of events) {
          target.push(event);
        }
        notifyQueueSpace(state);
        return events.length;
      },
      recv() {
        const event = state.queue.shift();
        if (event != null) {
          notifyQueueSpace(state);
          return Promise.resolve(event);
        }
        if (state.closeError != null) {
          return Promise.reject(state.closeError);
        }
        return new Promise((resolve, reject) => {
          state.recvWaiters.push({ resolve, reject });
        });
      },
      send(payload) {
        return send(payload);
      },
      [Symbol.asyncIterator]() {
        return clientAsyncIterator(() => this.recv());
      },
    }),
    async enqueue(event) {
      while (true) {
        if (state.closeError != null) {
          return false;
        }
        const waiter = state.recvWaiters.shift();
        if (waiter != null) {
          waiter.resolve(event);
          return true;
        }
        if (state.queue.length < MAX_QUEUED_MESSAGES) {
          state.queue.push(event);
          return true;
        }
        await waitForQueueSpace(state);
      }
    },
    enqueueDroppingOldest(event) {
      if (state.closeError != null) {
        return false;
      }
      const waiter = state.recvWaiters.shift();
      if (waiter != null) {
        waiter.resolve(event);
        return true;
      }
      if (state.queue.length === MAX_QUEUED_MESSAGES) {
        state.queue.shift();
      }
      state.queue.push(event);
      return true;
    },
    close(error) {
      if (state.closeError != null) {
        return;
      }
      state.closeError = error;
      for (const waiter of state.recvWaiters.splice(0)) {
        waiter.reject(error);
      }
      notifyQueueSpace(state);
    },
  };
}

function assertDrainTarget(target) {
  if (target == null || typeof target.push !== "function") {
    throw new TypeError("drainInto target must support push()");
  }
}

function clientAsyncIterator(recv) {
  return {
    async next() {
      return { value: await recv(), done: false };
    },
  };
}

function waitForQueueSpace(state) {
  if (state.queue.length < MAX_QUEUED_MESSAGES || state.closeError != null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    state.spaceWaiters.push(resolve);
  });
}

function notifyQueueSpace(state) {
  for (const resolve of state.spaceWaiters.splice(0)) {
    resolve();
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPayloadSize(bytes, maxSize) {
  if (bytes.byteLength > maxSize) {
    throw new RangeError("payload must be at most " + maxSize + " bytes");
  }
}

function datagramCompatibilityError() {
  return new Error(DATAGRAM_COMPATIBILITY_ERROR);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

let encoder;
let decoder;
let chatDecoder;

function textEncoder() {
  encoder ??= new TextEncoder();
  return encoder;
}

function textDecoder() {
  decoder ??= new TextDecoder();
  return decoder;
}

function chatTextDecoder() {
  chatDecoder ??= new TextDecoder("utf-8", { fatal: true });
  return chatDecoder;
}

function reportRuntimeError(error) {
  console.error(error);
}

function reportRuntimeStartupError(error) {
  reportRuntimeError(error);
  try {
    if (window.parent !== window) {
      window.parent.postMessage({
        type: "snack.runtimeError",
        version: 1,
        message: error instanceof Error ? error.message : String(error),
      }, "*");
    }
  } catch {
    // The console still has the original error.
  }
}
`;

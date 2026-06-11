import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const assetsDir = path.join(projectRoot, "assets");
const minionClientEntryId = "/minion/client-entry";
const minionClientModuleId = "minion:client";
const legacyMinionClientModuleId = "@minion/client";
const userClientEntryId = "/src/client.ts";
const resolvedMinionClientEntryId = `\0${minionClientEntryId}`;
const resolvedMinionClientModuleId = `\0${minionClientModuleId}`;
const clientDevHost = process.env.MINION_CLIENT_HOST ?? "127.0.0.1";
const clientDevPort = portFromEnv("MINION_CLIENT_PORT", 3031);

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

function minionClientRuntime(): Plugin {
  return {
    name: "minion-client-runtime",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace(
          /<script\s+type=["']module["']\s+src=["']\/src\/client\.ts["']><\/script>/,
          `<script type="module" src="${minionClientEntryId}"></script>`,
        );
      },
    },
    resolveId(id) {
      if (id === minionClientEntryId) {
        return resolvedMinionClientEntryId;
      }
      if (id === minionClientModuleId || id === legacyMinionClientModuleId) {
        return resolvedMinionClientModuleId;
      }
      return null;
    },
    load(id) {
      if (id === resolvedMinionClientEntryId) {
        return [
          `import { startMinionClientRuntime } from ${JSON.stringify(minionClientModuleId)};`,
          "await startMinionClientRuntime();",
          `await import(${JSON.stringify(userClientEntryId)});`,
          "",
        ].join("\n");
      }
      if (id === resolvedMinionClientModuleId) {
        return MINION_CLIENT_RUNTIME_SOURCE;
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

function minionAssets(): Plugin {
  return {
    name: "minion-assets",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        try {
          const pathname = new URL(request.url ?? "/", "http://minion.local").pathname;
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

          const contentType = contentTypeFor(candidate);
          if (contentType) {
            response.setHeader("Content-Type", contentType);
          }
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

function contentTypeFor(filePath: string): string | undefined {
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

  if (extension === ".wasm") {
    return "application/wasm";
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

  return undefined;
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
  plugins: [minionClientRuntime(), minionAssets()],
});

const MINION_CLIENT_RUNTIME_SOURCE = String.raw`
const READY_MESSAGE = Object.freeze({ type: "minion.ready", version: 1 });
const STREAM_KIND_CONTROL = 0;
const STREAM_KIND_MESSAGE = 1;
const LAUNCH_TIMEOUT_MS = 15000;
const NETWORK_RTT_PING_INTERVAL_MS = 1000;
const MAX_PENDING_RTT_SAMPLES = 32;
const RTT_EMA_ALPHA = 0.1;
const RTT_JITTER_EMA_ALPHA = 1 / 16;
const MAX_DATAGRAM_BYTES = 65536;
const MAX_STREAM_BYTES = 1048576;
const MAX_QUEUED_MESSAGES = 1024;
const DATAGRAM_COMPATIBILITY_ERROR = "This browser does not expose the WebTransport datagram API required by Minion.Game. Update your browser or use a current Safari, Chrome, Edge, or Firefox build with WebTransport datagram support.";

const runtime = createRuntime();
const datagramWritables = new WeakMap();

export const client = runtime.client;

export function startMinionClientRuntime() {
  return runtime.started;
}

function createRuntime() {
  const networkStats = createNetworkStats();
  const transportReady = deferred();
  const launchReady = deferred();
  const connectionReady = deferred();
  const publicReady = transportReady.promise.then(() => undefined);
  const closed = transportReady.promise.then(
    (transport) => transport.closed.then(() => undefined, () => undefined),
    () => undefined,
  );
  const datagrams = createClientChannel(MAX_DATAGRAM_BYTES, (payload) => {
    return sendDatagram(transportReady.promise, payload);
  });
  const streams = createClientChannel(MAX_STREAM_BYTES, (payload) => {
    return sendStream(transportReady.promise, payload);
  });

  const client = Object.freeze({
    launch: launchReady.promise,
    connection: connectionReady.promise,
    net: networkStats.view,
    ready: publicReady,
    closed,
    datagrams: datagrams.channel,
    streams: streams.channel,
  });

  void closed.then(() => {
    const error = new Error("Minion client connection closed");
    datagrams.close(error);
    streams.close(error);
  });
  void connect({
    datagrams,
    streams,
    networkStats,
    transportReady,
    launchReady,
    connectionReady,
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

    void readStreams(transport, state.streams, state.connectionReady, transport, state.networkStats).catch(reportRuntimeError);

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
    return Promise.reject(new Error("Minion launch envelope is required"));
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onLaunchMessage);
      reject(new Error("Minion launch envelope timed out"));
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

  return value.type === "minion.launch"
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

async function sampleNetworkRtt(transport, networkStats) {
  const closed = transport.closed.then(() => true, () => true);

  while (true) {
    const pingId = networkStats.nextPingId();
    await sendControlMessage(transport, { type: "ping", id: pingId });
    networkStats.recordPing(pingId, performance.now());
    const isClosed = await Promise.race([
      sleep(NETWORK_RTT_PING_INTERVAL_MS).then(() => false),
      closed,
    ]);
    if (isClosed) {
      return;
    }
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

async function readStreams(transport, streamChannel, connectionReady, controlTransport, networkStats) {
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
        connectionReady,
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

async function readStream(stream, streamChannel, connectionReady, controlTransport, networkStats) {
  const bytes = await readAllBytes(stream);
  const kind = bytes[0];
  const payload = bytes.slice(1);
  if (kind === STREAM_KIND_CONTROL) {
    handleControlMessage(payload, connectionReady, controlTransport, networkStats);
    return true;
  }
  if (kind === STREAM_KIND_MESSAGE) {
    return await streamChannel.enqueue(messageEvent("stream", payload));
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

function handleControlMessage(bytes, connectionReady, transport, networkStats) {
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

  if (message.type !== "welcome" || typeof message.connectionId !== "string") {
    return;
  }

  connectionReady.resolve(Object.freeze({
    connectionId: message.connectionId,
    userId: typeof message.userId === "string" ? message.userId : message.connectionId,
    userName: typeof message.userName === "string" ? message.userName : message.connectionId,
    isGuest: Boolean(message.isGuest),
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

function createClientChannel(maxSize, send) {
  const state = {
    queue: [],
    recvWaiters: [],
    spaceWaiters: [],
    closeError: null,
  };
  return {
    channel: Object.freeze({
      maxSize,
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

function textEncoder() {
  encoder ??= new TextEncoder();
  return encoder;
}

function textDecoder() {
  decoder ??= new TextDecoder();
  return decoder;
}

function reportRuntimeError(error) {
  console.error(error);
}

function reportRuntimeStartupError(error) {
  reportRuntimeError(error);
  try {
    if (window.parent !== window) {
      window.parent.postMessage({
        type: "minion.runtimeError",
        version: 1,
        message: error instanceof Error ? error.message : String(error),
      }, "*");
    }
  } catch {
    // The console still has the original error.
  }
}
`;

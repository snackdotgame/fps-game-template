declare module "snack:server" {
  export type NetworkMessage =
    | string
    | number
    | boolean
    | null
    | NetworkMessage[]
    | { [key: string]: NetworkMessage };

  export type ServerConfigValue = string | number | boolean;

  export type ServerConfig = { readonly [key: string]: ServerConfigValue };

  export type DatagramPayload =
    | NetworkMessage
    | Uint8Array
    | ArrayBuffer
    | ArrayBufferView
    | string;

  export type StreamPayload = DatagramPayload;

  export type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { readonly [key: string]: JsonValue };

  export type JsonObject = { readonly [key: string]: JsonValue };
  export type ChatPayload = string | JsonObject;

  export interface BroadcastOptions {
    only?: readonly string[];
    except?: readonly string[];
  }

  export interface NetStats {
    readonly rtt: number | null;
    readonly latestRtt: number | null;
    readonly jitter: number | null;
  }

  export interface NetworkEvent {
    readonly connection: Connection;
    readonly bytes: Uint8Array;
    readonly receivedAt: number;
    json<T = unknown>(): T;
    text(): string;
  }

  export interface DatagramEvent extends NetworkEvent {
    readonly type: "datagram";
  }

  export interface StreamEvent extends NetworkEvent {
    readonly type: "stream";
  }

  export interface ServerChatMessage {
    readonly messageId: string;
    readonly connection: Connection;
    readonly payload: ChatPayload;
    readonly receivedAt: number;
  }

  export type ChatSendOptions = BroadcastOptions;

  export interface ServerChat extends AsyncIterable<ServerChatMessage> {
    readonly maxTextLength: number;
    readonly maxStructuredPayloadBytes: number;
    drain(): ServerChatMessage[];
    drainInto(target: ServerChatMessage[]): number;
    recv(): Promise<ServerChatMessage>;
    /** Relayed messages must remain within Snack's bounded recent-attribution window. */
    send(payload: ChatPayload | ServerChatMessage, options?: ChatSendOptions): void;
  }

  export interface ServerDatagrams extends AsyncIterable<DatagramEvent> {
    readonly maxSize: number;
    drain(): DatagramEvent[];
    drainInto(target: DatagramEvent[]): number;
    recv(): Promise<DatagramEvent>;
    send(connectionId: string, payload: DatagramPayload): void;
    broadcast(payload: DatagramPayload, options?: BroadcastOptions): void;
  }

  export interface ConnectionDatagrams extends AsyncIterable<DatagramEvent> {
    readonly maxSize: number;
    drain(): DatagramEvent[];
    drainInto(target: DatagramEvent[]): number;
    recv(): Promise<DatagramEvent>;
    send(payload: DatagramPayload): void;
  }

  export interface ServerStreams extends AsyncIterable<StreamEvent> {
    readonly maxSize: number;
    drain(): StreamEvent[];
    drainInto(target: StreamEvent[]): number;
    recv(): Promise<StreamEvent>;
    send(connectionId: string, payload: StreamPayload): void;
    broadcast(payload: StreamPayload, options?: BroadcastOptions): void;
  }

  export interface ConnectionStreams extends AsyncIterable<StreamEvent> {
    readonly maxSize: number;
    drain(): StreamEvent[];
    drainInto(target: StreamEvent[]): number;
    recv(): Promise<StreamEvent>;
    send(payload: StreamPayload): void;
  }

  export interface Connection {
    readonly id: string;
    readonly userId: string;
    readonly userName: string;
    readonly isGuest: boolean;
    readonly connectedAt: number;
    readonly net: NetStats;
    readonly datagrams: ConnectionDatagrams;
    readonly streams: ConnectionStreams;
    close(reason?: string): void;
  }

  export type DatabaseValue = null | string | number | bigint | Uint8Array;
  export type DatabaseBindingValue = DatabaseValue | ArrayBufferView;
  /** Named bindings accept full SQLite prefixes or an unambiguous bare name. */
  export type DatabaseNamedParameters = Readonly<Record<string, DatabaseBindingValue>>;
  export type DatabaseErrorCode =
    | "BUSY"
    | "CONSTRAINT"
    | "INVALID_SQL"
    | "QUOTA_EXCEEDED"
    | "READ_ONLY"
    | "LEASE_EXPIRED"
    | "UNAVAILABLE";

  export interface DatabaseError extends Error {
    readonly name: "DatabaseError";
    readonly code: DatabaseErrorCode;
  }

  export interface DatabaseRunResult {
    readonly changes: number | bigint;
    readonly lastInsertRowid: number | bigint;
  }

  /**
   * A batch result. The metadata parameter follows the batch's readBigInts option and defaults
   * to number, so plain `DatabaseRawResult` keeps meaning exactly what it did before the option
   * existed.
   */
  export interface DatabaseRawResult<Metadata extends number | bigint = number> {
    readonly columns: readonly string[];
    readonly rows: readonly (readonly DatabaseValue[])[];
    readonly changes: Metadata;
    readonly lastInsertRowid: Metadata | null;
  }

  export interface DatabaseBatchStatement {
    readonly sql: string;
    readonly args?: readonly DatabaseBindingValue[] | DatabaseNamedParameters;
    readonly method?: "run" | "get" | "all" | "values";
  }

  export interface DatabaseStatement<Row extends object = Readonly<Record<string, DatabaseValue>>> {
    readonly sourceSQL: string;
    get(...args: readonly DatabaseBindingValue[]): Row | undefined;
    get(
      args: DatabaseNamedParameters,
      ...anonymousParameters: readonly DatabaseBindingValue[]
    ): Row | undefined;
    all(...args: readonly DatabaseBindingValue[]): readonly Row[];
    all(
      args: DatabaseNamedParameters,
      ...anonymousParameters: readonly DatabaseBindingValue[]
    ): readonly Row[];
    getValues(...args: readonly DatabaseBindingValue[]): readonly DatabaseValue[] | undefined;
    getValues(
      args: DatabaseNamedParameters,
      ...anonymousParameters: readonly DatabaseBindingValue[]
    ): readonly DatabaseValue[] | undefined;
    values(...args: readonly DatabaseBindingValue[]): readonly (readonly DatabaseValue[])[];
    values(
      args: DatabaseNamedParameters,
      ...anonymousParameters: readonly DatabaseBindingValue[]
    ): readonly (readonly DatabaseValue[])[];
    run(...args: readonly DatabaseBindingValue[]): DatabaseRunResult;
    run(
      args: DatabaseNamedParameters,
      ...anonymousParameters: readonly DatabaseBindingValue[]
    ): DatabaseRunResult;
    /** Allows unambiguous parameter names without their SQLite prefix. Enabled by default. */
    setAllowBareNamedParameters(enabled: boolean): void;
    /** Ignores unknown named parameters when enabled. Disabled by default. */
    setAllowUnknownNamedParameters(enabled: boolean): void;
    /** Reads SQLite INTEGER values and run metadata as bigint when enabled. */
    setReadBigInts(enabled: boolean): void;
    /**
     * Makes get() and all() return positional arrays when enabled. Like node:sqlite, this
     * void toggle is not reflected in the statement's static row type; use getValues() or
     * values() when the array result needs to be represented in TypeScript.
     */
    setReturnArrays(enabled: boolean): void;
  }

  export interface LocalDatabase {
    /**
     * Compiles one SQL statement synchronously and initializes the database when needed.
     * Database work should stay outside the simulation loop. Methods return direct values and
     * throw synchronously; do not await them or put asynchronous work inside a transaction.
     */
    prepare<Row extends object = Readonly<Record<string, DatabaseValue>>>(
      sql: string,
    ): DatabaseStatement<Row>;
    /** Executes a SQL script as supplied. No transaction is added implicitly. */
    exec(sql: string): void;
    /**
     * Executes an atomic batch. Transaction-control statements are not allowed inside the batch.
     * Set readBigInts to read INTEGER values and result metadata as bigint, the batch equivalent
     * of a statement's setReadBigInts(). Without it, a value outside the safe integer range throws
     * while the batch's results are decoded, after the batch has already committed.
     */
    batch(
      statements: readonly DatabaseBatchStatement[],
      options: {
        readonly mode?: "read" | "write" | "deferred";
        readonly readBigInts: true;
      },
    ): readonly DatabaseRawResult<bigint>[];
    batch(
      statements: readonly DatabaseBatchStatement[],
      options?: {
        readonly mode?: "read" | "write" | "deferred";
        readonly readBigInts?: false;
      },
    ): readonly DatabaseRawResult[];
    batch(
      statements: readonly DatabaseBatchStatement[],
      options: {
        readonly mode?: "read" | "write" | "deferred";
        readonly readBigInts: boolean;
      },
    ): readonly DatabaseRawResult<number | bigint>[];
  }

  export interface Server {
    readonly config: ServerConfig;
    readonly running: boolean;
    readonly connections: readonly Connection[];
    readonly chat: ServerChat;
    readonly datagrams: ServerDatagrams;
    readonly streams: ServerStreams;
    /**
     * This session's host-owned SQLite database. The first prepare(), exec(), or batch() call
     * initializes it. It has a 200 MiB maximum and cannot load custom extensions. When
     * server.persistence is true in snack.json, kept games retain it across sessions. Otherwise it
     * is local to this server and is discarded when the server exits. Run versioned migrations
     * during startup before gameplay.
     */
    readonly localDb: LocalDatabase;
    end(): void;
    elapsedMs(): number;
    sleep(ms: number): Promise<void>;
  }

  export const server: Server;
}

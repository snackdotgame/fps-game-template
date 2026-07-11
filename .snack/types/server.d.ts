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

  export interface Server {
    readonly config: ServerConfig;
    readonly running: boolean;
    readonly connections: readonly Connection[];
    readonly chat: ServerChat;
    readonly datagrams: ServerDatagrams;
    readonly streams: ServerStreams;
    end(): void;
    elapsedMs(): number;
    sleep(ms: number): Promise<void>;
  }

  export const server: Server;
}

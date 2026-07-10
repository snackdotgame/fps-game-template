declare module "snack:client" {
  export type NetworkMessage =
    | string
    | number
    | boolean
    | null
    | NetworkMessage[]
    | { [key: string]: NetworkMessage };

  export type Payload = NetworkMessage | Uint8Array | ArrayBuffer | ArrayBufferView | string;

  export type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { readonly [key: string]: JsonValue };

  export type JsonObject = { readonly [key: string]: JsonValue };
  export type ChatPayload = string | JsonObject;

  export interface CertificateHash {
    readonly algorithm: "sha-256";
    readonly value: readonly number[];
  }

  export interface LaunchTransport {
    readonly type: "webtransport";
    readonly url: string;
    readonly serverCertificateHashes: readonly CertificateHash[];
  }

  export interface LaunchEnvelope {
    readonly type: "snack.launch";
    readonly version: 1;
    readonly launchId: string;
    readonly user: {
      readonly userId: string;
      readonly userName: string;
      readonly avatarUrl?: string;
      readonly isGuest: boolean;
    };
    readonly game: {
      readonly gameId: string;
      readonly versionId: string;
      readonly instanceId: string;
      readonly region: string;
    };
    readonly transport: LaunchTransport;
  }

  export interface Connection {
    readonly connectionId: string;
    readonly userId: string;
    readonly userName: string;
    readonly isGuest: boolean;
  }

  export interface NetStats {
    readonly rtt: number | null;
    readonly latestRtt: number | null;
    readonly jitter: number | null;
  }

  export interface NetworkEvent {
    readonly bytes: Uint8Array;
    readonly receivedAt: number;
    text(): string;
    json<T = unknown>(): T;
  }

  export interface DatagramEvent extends NetworkEvent {
    readonly type: "datagram";
  }

  export interface StreamEvent extends NetworkEvent {
    readonly type: "stream";
  }

  export interface ChatSender {
    readonly connectionId: string;
    readonly userId: string;
    readonly userName: string;
    readonly isGuest: boolean;
  }

  export interface ChatMessage {
    readonly messageId: string;
    readonly sequence: number;
    readonly source: "player" | "server";
    readonly sender: ChatSender | null;
    readonly payload: ChatPayload;
    readonly sentAt: number;
    readonly deliveredAt: number;
  }

  export interface ClientChat extends AsyncIterable<ChatMessage> {
    readonly maxTextLength: number;
    readonly maxStructuredPayloadBytes: number;
    drain(): ChatMessage[];
    drainInto(target: ChatMessage[]): number;
    recv(): Promise<ChatMessage>;
    send(payload: ChatPayload): Promise<void>;
  }

  export interface ClientDatagrams extends AsyncIterable<DatagramEvent> {
    readonly maxSize: number;
    drain(): DatagramEvent[];
    drainInto(target: DatagramEvent[]): number;
    recv(): Promise<DatagramEvent>;
    send(payload: Payload): Promise<void>;
  }

  export interface ClientStreams extends AsyncIterable<StreamEvent> {
    readonly maxSize: number;
    drain(): StreamEvent[];
    drainInto(target: StreamEvent[]): number;
    recv(): Promise<StreamEvent>;
    send(payload: Payload): Promise<void>;
  }

  export interface Client {
    readonly launch: Promise<LaunchEnvelope>;
    readonly connection: Promise<Connection>;
    readonly net: NetStats;
    readonly ready: Promise<void>;
    readonly closed: Promise<void>;
    readonly chat: ClientChat;
    readonly datagrams: ClientDatagrams;
    readonly streams: ClientStreams;
  }

  export const client: Client;
}

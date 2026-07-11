# Global And Team Text Chat Example

This example lets clients request global or team text chat. The authoritative server validates the
payload, derives team recipients from server-owned state, and relays the original message to
preserve trusted player attribution.

```ts
// src/shared/chat.ts
export type ChatChannel = "global" | "team";

export type PlayerTextChatPayload = {
  type: "text-chat";
  channel: ChatChannel;
  text: string;
};

export type SystemTextChatPayload = {
  type: "system";
  text: string;
};

export type GameChatPayload = PlayerTextChatPayload | SystemTextChatPayload;

function isWithinStructuredChatLimits(
  payload: GameChatPayload,
  maxTextLength: number,
  maxStructuredPayloadBytes: number,
): boolean {
  const textLength = Object.values(payload).reduce(
    (total, value) => total + (typeof value === "string" ? [...value].length : 0),
    0,
  );
  const json = JSON.stringify(payload);
  return (
    textLength <= maxTextLength &&
    new TextEncoder().encode(json).byteLength <= maxStructuredPayloadBytes
  );
}

export function parsePlayerTextChat(
  payload: unknown,
  maxTextLength: number,
  maxStructuredPayloadBytes: number,
): PlayerTextChatPayload | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (
    record.type !== "text-chat" ||
    (record.channel !== "global" && record.channel !== "team") ||
    typeof record.text !== "string"
  ) {
    return undefined;
  }
  const text = record.text.trim();
  if (text.length === 0) {
    return undefined;
  }
  const parsed: PlayerTextChatPayload = { type: "text-chat", channel: record.channel, text };
  return isWithinStructuredChatLimits(parsed, maxTextLength, maxStructuredPayloadBytes)
    ? parsed
    : undefined;
}

export function parseSystemTextChat(
  payload: unknown,
  maxTextLength: number,
  maxStructuredPayloadBytes: number,
): SystemTextChatPayload | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (record.type !== "system" || typeof record.text !== "string") {
    return undefined;
  }
  const text = record.text.trim();
  const parsed: SystemTextChatPayload = { type: "system", text };
  return text.length > 0 &&
    isWithinStructuredChatLimits(parsed, maxTextLength, maxStructuredPayloadBytes)
    ? parsed
    : undefined;
}

export function parseGameChat(
  payload: unknown,
  maxTextLength: number,
  maxStructuredPayloadBytes: number,
): GameChatPayload | undefined {
  return (
    parsePlayerTextChat(payload, maxTextLength, maxStructuredPayloadBytes) ??
    parseSystemTextChat(payload, maxTextLength, maxStructuredPayloadBytes)
  );
}
```

```ts
// src/server.ts
import { server, type ChatSendOptions } from "snack:server";
import { parsePlayerTextChat, parseSystemTextChat } from "./shared/chat.js";

// This map is the authoritative match roster, not a connection-lifetime cache. All simultaneous
// connections for one user share a team. Remove the entry only when that logical player leaves.
const teamByUserId = new Map<string, string>();

export function setPlayerTeam(userId: string, teamId: string | undefined): void {
  if (teamId === undefined) {
    teamByUserId.delete(userId);
  } else {
    teamByUserId.set(userId, teamId);
  }
}

export function removePlayerFromMatch(userId: string): void {
  teamByUserId.delete(userId);
}

export function clearMatchRoster(): void {
  teamByUserId.clear();
}

export function sendSystemText(text: string, options?: ChatSendOptions): void {
  const payload = parseSystemTextChat(
    { type: "system", text },
    server.chat.maxTextLength,
    server.chat.maxStructuredPayloadBytes,
  );
  if (!payload) {
    return;
  }
  server.chat.send(payload, options);
}

export async function main() {
  while (server.running) {
    const message = await receiveChat();
    if (!message) {
      return;
    }
    const payload = parsePlayerTextChat(
      message.payload,
      server.chat.maxTextLength,
      server.chat.maxStructuredPayloadBytes,
    );
    if (!payload) {
      continue;
    }
    if (payload.channel === "global") {
      server.chat.send(message);
      continue;
    }

    const teamId = teamByUserId.get(message.connection.userId);
    if (!teamId) {
      continue;
    }
    const only = server.connections
      .filter((connection) => teamByUserId.get(connection.userId) === teamId)
      .map((connection) => connection.id);
    server.chat.send(message, { only });
  }
}

async function receiveChat() {
  try {
    return await server.chat.recv();
  } catch {
    return undefined;
  }
}
```

```ts
// src/client.ts
import { client, type ChatMessage } from "snack:client";
import {
  parseGameChat,
  parsePlayerTextChat,
  type ChatChannel,
  type GameChatPayload,
} from "./shared/chat.js";

const MAX_SEEN_MESSAGE_IDS = 256;

export type ReceivedTextChat = {
  messageId: string;
  sequence: number;
  source: "player" | "server";
  sender: ChatMessage["sender"];
  payload: GameChatPayload;
  sentAt: number;
  deliveredAt: number;
};

export async function sendTextChat(channel: ChatChannel, text: string): Promise<void> {
  const payload = parsePlayerTextChat(
    { type: "text-chat", channel, text },
    client.chat.maxTextLength,
    client.chat.maxStructuredPayloadBytes,
  );
  if (!payload) {
    throw new Error("Text chat message is empty or exceeds chat limits");
  }
  await client.chat.send(payload);
}

export async function receiveTextChat(deliver: (message: ReceivedTextChat) => void): Promise<void> {
  const seenIds = new Set<string>();
  const seenOrder: string[] = [];
  try {
    while (true) {
      const message = await client.chat.recv();
      if (seenIds.has(message.messageId)) {
        continue;
      }
      const payload = parseGameChat(
        message.payload,
        client.chat.maxTextLength,
        client.chat.maxStructuredPayloadBytes,
      );
      if (!payload) {
        continue;
      }
      seenIds.add(message.messageId);
      seenOrder.push(message.messageId);
      while (seenOrder.length > MAX_SEEN_MESSAGE_IDS) {
        const expired = seenOrder.shift();
        if (expired) {
          seenIds.delete(expired);
        }
      }
      deliver({
        messageId: message.messageId,
        sequence: message.sequence,
        source: message.source,
        sender: message.sender,
        payload,
        sentAt: message.sentAt,
        deliveredAt: message.deliveredAt,
      });
    }
  } catch {
    await client.closed;
  }
}
```

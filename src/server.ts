import { server, type NetworkMessage } from "minion:server";
import { READY_MESSAGE } from "./shared/messages.js";

export async function main() {
  server.datagrams.broadcast({ type: READY_MESSAGE });

  while (server.running) {
    const event = await recvDatagram();
    if (!event) {
      return;
    }
    const text = chatText(event.json());
    if (text) {
      server.datagrams.broadcast({
        type: "chat",
        userId: event.connection.userId,
        userName: event.connection.userName,
        text,
      });
    }
  }
}

async function recvDatagram() {
  try {
    return await server.datagrams.recv();
  } catch {
    return undefined;
  }
}

function chatText(message: NetworkMessage): string | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return undefined;
  }

  const text = message.text;
  if (typeof text !== "string") {
    return undefined;
  }

  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 280) : undefined;
}

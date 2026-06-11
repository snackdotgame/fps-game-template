import { client } from "minion:client";
import { READY_MESSAGE } from "./shared/messages.js";

const root = document.querySelector("#app");

if (root) {
  root.replaceChildren(createChat());
}

function createChat(): HTMLElement {
  document.body.style.cssText = "margin: 0; background: #f6f6f2; color: #181818;";

  const shell = document.createElement("main");
  shell.style.cssText =
    "font-family: system-ui, sans-serif; max-width: 680px; margin: 40px auto; padding: 0 20px; color: #181818;";

  const heading = document.createElement("h1");
  heading.textContent = "Minion Chat";

  const status = document.createElement("p");
  status.textContent = `Server ${READY_MESSAGE}: connecting`;

  const messages = document.createElement("ul");
  messages.style.cssText =
    "min-height: 240px; padding: 16px; border: 1px solid #d8d8d0; background: #ffffff; list-style: none;";

  const form = document.createElement("form");
  form.style.cssText = "display: flex; gap: 8px;";

  const input = document.createElement("input");
  input.name = "message";
  input.placeholder = "Say something";
  input.autocomplete = "off";
  input.style.cssText = "flex: 1; padding: 10px;";

  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Send";
  button.style.cssText = "padding: 10px 14px;";

  form.append(input, button);
  shell.append(heading, status, messages, form);

  connect(status, messages);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      return;
    }
    void client.datagrams.send({ type: "chat", text }).then(() => {
      input.value = "";
    });
  });

  return shell;
}

function connect(status: HTMLParagraphElement, messages: HTMLUListElement): void {
  void readMessages(messages);

  void client.ready
    .then(() => {
      status.textContent = "Server ready: connected";
      console.debug("Network RTT", client.net.rtt, client.net.latestRtt, client.net.jitter);
    })
    .catch((error: unknown) => {
      console.error(error);
      status.textContent = "Server ready: disconnected";
    });

  void client.closed.then(() => {
    status.textContent = "Server ready: disconnected";
  });
}

async function readMessages(messages: HTMLUListElement): Promise<void> {
  try {
    while (true) {
      const event = await client.datagrams.recv();
      readIncomingMessage(event.bytes, messages);
    }
  } catch {
    await client.closed;
  }
}

function readIncomingMessage(bytes: Uint8Array, messages: HTMLUListElement): void {
  const data = new TextDecoder().decode(bytes);
  const message = parseMessage(data);
  if (isChatMessage(message)) {
    appendMessage(messages, `${message.userName}: ${message.text}`);
  } else if (isSystemMessage(message)) {
    appendMessage(messages, message.text);
  }
}

function parseMessage(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

function isChatMessage(
  message: unknown,
): message is { type: "chat"; userId: string; userName: string; text: string } {
  return (
    hasStringField(message, "type", "chat") &&
    hasStringField(message, "userId") &&
    hasStringField(message, "userName") &&
    hasStringField(message, "text")
  );
}

function isSystemMessage(message: unknown): message is { type: "system"; text: string } {
  return hasStringField(message, "type", "system") && hasStringField(message, "text");
}

function hasStringField(message: unknown, key: string, expected?: string): boolean {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return false;
  }
  const value = (message as Record<string, unknown>)[key];
  return typeof value === "string" && (expected === undefined || value === expected);
}

function appendMessage(messages: HTMLUListElement, text: string): void {
  const item = document.createElement("li");
  item.textContent = text;
  messages.append(item);
}

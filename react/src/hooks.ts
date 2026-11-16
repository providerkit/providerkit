/**
 * React bindings for the client: `useChat` for a conversation the person writes in, and
 * `useAgentRun` for a run they only watch and answer.
 *
 * Both read one client through `useSyncExternalStore`, so a render always sees one consistent
 * state, and a component re-renders only when that state changed. Nothing here reads `window` or
 * `document`, so they render on a server: observation starts in an effect, which a server never
 * runs.
 */
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  createChatClient,
  type ChatClient,
  type ChatClientOptions,
  type ChatState,
} from "./client.ts";

export interface UseChatOptions extends ChatClientOptions {
  /** Names the conversation and the person reading it. When it changes, the hook drops everything
   * it holds and starts over, so nothing from the last conversation or account can show in this
   * one, however late it arrives. Leave it out for a hook that only ever shows one. */
  id?: string;
}

export type UseAgentRunOptions = Omit<UseChatOptions, "allowSendWhileRunning">;

export interface ChatValue extends ChatState {
  send: ChatClient["send"];
  retry: ChatClient["retry"];
  stop: ChatClient["stop"];
  respond: ChatClient["respond"];
  reconnect: ChatClient["reconnect"];
}

/** The same state without what belongs to sending: a panel that watches a run never writes in it. */
export interface AgentRunValue extends Omit<ChatState, "canSend" | "messageErrors"> {
  stop: ChatClient["stop"];
  respond: ChatClient["respond"];
  reconnect: ChatClient["reconnect"];
}

/** One client per conversation key. A new key gets a new client in the same render, so the first
 * frame of the new conversation is already its own. The old client only detaches: whatever it
 * still receives lands in an object nobody reads. */
function useClient(options: UseChatOptions): ChatClient {
  const { id } = options;
  const [held, setHeld] = useState(() => ({ id, client: createChatClient(options) }));
  let { client } = held;
  if (held.id !== id) {
    const next = { id, client: createChatClient(options) };
    setHeld(next);
    client = next.client;
  }
  // Every render: an app that builds its transport inline hands a new one each time, and the next
  // command must use the one this render had. Before paint, so no click can come in between.
  useLayoutEffect(() => {
    client.setOptions(options);
  });
  // Strict Mode attaches, detaches and attaches the same client again: the second observation
  // replaces the first, which closes.
  useEffect(() => client.attach(), [client]);
  return client;
}

function useClientState(client: ChatClient): ChatState {
  return useSyncExternalStore(client.subscribe, client.getState, client.getState);
}

/**
 * A conversation: its messages, its run, and the commands the person gives.
 *
 * ```tsx
 * const chat = useChat({ transport });
 * <button onClick={() => chat.send("Summarize this page.")}>Summarize</button>;
 * ```
 */
export function useChat(options: UseChatOptions): ChatValue {
  const client = useClient(options);
  const state = useClientState(client);
  return useMemo(
    () => ({
      ...state,
      send: client.send,
      retry: client.retry,
      stop: client.stop,
      respond: client.respond,
      reconnect: client.reconnect,
    }),
    [client, state],
  );
}

/**
 * A run to watch and answer, such as a background agent's: the same store as `useChat`, without
 * sending. Open it mid-run and it catches up from the host; open it after the run ended and it
 * shows how it ended.
 */
export function useAgentRun(options: UseAgentRunOptions): AgentRunValue {
  const client = useClient(options);
  const state = useClientState(client);
  return useMemo(() => {
    const { canSend: _canSend, messageErrors: _messageErrors, ...rest } = state;
    return {
      ...rest,
      stop: client.stop,
      respond: client.respond,
      reconnect: client.reconnect,
    };
  }, [client, state]);
}

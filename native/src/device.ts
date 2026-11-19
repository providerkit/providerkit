/**
 * Whether the app is on screen and the phone is online, from React Native's `AppState` and NetInfo,
 * which the app passes in. The stream transport reads it two ways: a reconnect waits until the app
 * is on screen and online, and a silent stream is judged only while the app is on screen.
 *
 * Imports nothing from React Native, so it runs, and is tested, under Node.
 */

/** The part of React Native's `AppState` this file reads. */
export interface AppStateLike {
  readonly currentState?: string | null;
  addEventListener(type: "change", listener: (state: string) => void): { remove(): void };
}

/** The part of NetInfo (`@react-native-community/netinfo`) this file reads. */
export interface NetInfoLike {
  addEventListener(listener: (state: { isConnected: boolean | null }) => void): () => void;
}

export interface DeviceOptions {
  appState: AppStateLike;
  /** Leave it out when the app has no NetInfo. The phone then always counts as online. */
  netInfo?: NetInfoLike;
}

export interface Device {
  /** False only while the app is in the background. */
  readonly active: boolean;
  /** True only while NetInfo says there is no connection. Turn Send and Retry off while it is true:
   * the transport sends every command it is given. */
  readonly offline: boolean;
  /** Called after `active` or `offline` changed, never during `subscribe`. Returns the function
   * that stops it. */
  subscribe(listener: () => void): () => void;
  /** Stops listening to AppState and NetInfo. An app that watches for as long as it runs never
   * needs it. */
  stop(): void;
}

/**
 * Starts watching. Call it once, beside your API client, and pass the result to
 * `createSseTransport`.
 *
 * ```ts
 * const device = watchDevice({ appState: AppState, netInfo: NetInfo });
 * ```
 */
export function watchDevice(options: DeviceOptions): Device {
  const { appState, netInfo } = options;
  const listeners = new Set<() => void>();
  // "inactive" is a call, Control Center or the app switcher over the app. The app and its stream
  // keep running then, so only "background" counts as away.
  let active = appState.currentState !== "background";
  // NetInfo says `null` until it knows, which happens at every launch. Read as offline, that would
  // hold the first stream and turn Send off at the start of every session.
  let offline = false;
  function notify(): void {
    for (const listener of [...listeners]) listener();
  }
  const app = appState.addEventListener("change", (state) => {
    const next = state !== "background";
    if (next === active) return;
    active = next;
    notify();
  });
  const net = netInfo?.addEventListener((state) => {
    const next = state.isConnected === false;
    if (next === offline) return;
    offline = next;
    notify();
  });
  return {
    get active() {
      return active;
    },
    get offline() {
      return offline;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop() {
      app.remove();
      net?.();
      listeners.clear();
    },
  };
}

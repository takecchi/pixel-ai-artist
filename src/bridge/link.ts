/**
 * What every tool talks to: one Aseprite that answers named commands.
 *
 * Two implementations; `LinkSelector` holds both and switches only on an
 * explicit `preflight mode=…`:
 *  - `LiveClient` — the user's open editor, through the bridge;
 *  - `HeadlessClient` — a batch Aseprite this server owns, for when there is
 *    no window at all (CI, scripted asset builds, remote machines).
 *
 * Never a fallback from one to the other. A live session that drops must stay
 * a refusal: silently continuing in a headless process would edit files the
 * user's window then overwrites (docs/adr/0008-headless-mode.md).
 */

import type { HelloFrame } from "../lib/protocol.js";

export interface CallOptions {
  /** Reply fields the caller goes on to read; see LiveClient.call. */
  expect?: readonly string[];
  timeoutMs?: number;
}

export interface AsepriteLink {
  readonly mode: "live" | "headless";
  /** Live: the bridge socket is open. Headless: the batch process is running. */
  readonly bridgeConnected: boolean;
  /** An Aseprite is attached and has said hello. */
  readonly pluginConnected: boolean;
  readonly hello: HelloFrame | null;
  readonly features: string[];
  hasFeature(name: string): boolean;
  waitForBridge(ms?: number): Promise<boolean>;
  waitForPlugin(ms?: number): Promise<boolean>;
  call<T = unknown>(cmd: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<T>;
  close(): void;
}

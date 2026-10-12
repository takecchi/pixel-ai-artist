/**
 * The link every tool holds: whichever of the two Aseprites this session is
 * working with, switched only by an explicit `preflight mode=…`.
 *
 * Both links are created on first use and kept for the life of the server, so
 * switching never loses anything: the user's window keeps its documents, and
 * the headless process keeps its own unsaved ones for when the session comes
 * back to it. Nothing here switches on its own — a live call that fails still
 * fails (docs/adr/0008-headless-mode.md).
 */

import type { HelloFrame } from "../lib/protocol.js";
import type { LiveClient } from "./client.js";
import type { HeadlessClient } from "./headless.js";
import type { AsepriteLink, CallOptions } from "./link.js";

export type LinkMode = AsepriteLink["mode"];

export interface LinkFactory {
  live(): LiveClient;
  headless(): HeadlessClient;
}

export class LinkSelector implements AsepriteLink {
  private readonly factory: LinkFactory;
  private liveLink: LiveClient | null = null;
  private headlessLink: HeadlessClient | null = null;
  private current: AsepriteLink;

  constructor(factory: LinkFactory, initial: LinkMode) {
    this.factory = factory;
    this.current = this.link(initial);
  }

  /** Makes `mode` the link every later call goes to. Returns whether it changed. */
  use(mode: LinkMode): boolean {
    if (mode === this.current.mode) return false;
    this.current = this.link(mode);
    return true;
  }

  get mode(): LinkMode {
    return this.current.mode;
  }

  get bridgeConnected(): boolean {
    return this.current.bridgeConnected;
  }

  get pluginConnected(): boolean {
    return this.current.pluginConnected;
  }

  get hello(): HelloFrame | null {
    return this.current.hello;
  }

  get features(): string[] {
    return this.current.features;
  }

  hasFeature(name: string): boolean {
    return this.current.hasFeature(name);
  }

  waitForBridge(ms?: number): Promise<boolean> {
    return this.current.waitForBridge(ms);
  }

  waitForPlugin(ms?: number): Promise<boolean> {
    return this.current.waitForPlugin(ms);
  }

  call<T = unknown>(cmd: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<T> {
    return this.current.call<T>(cmd, args, opts);
  }

  close(): void {
    this.liveLink?.close();
    this.headlessLink?.close();
  }

  private link(mode: LinkMode): AsepriteLink {
    if (mode === "headless") return (this.headlessLink ??= this.factory.headless());
    return (this.liveLink ??= this.factory.live());
  }
}

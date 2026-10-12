/**
 * Headless mode: this server owns one batch Aseprite (`aseprite -b`) running
 * headless/runner.lua, and speaks to it in JSON lines over stdin/stdout.
 *
 * The process is long-lived on purpose. One `aseprite -b` per call — the
 * obvious design — reopens and resaves every document on every call, loses
 * the active layer and frame between calls, and makes an unsaved sprite
 * impossible. A single process keeps documents in memory exactly as the editor
 * does, so every tool behaves the same in both modes and `save` means save.
 *
 * Opt-in only (`serve --headless`). See docs/adr/0008-headless-mode.md for why
 * this is never a fallback for a live session that went away.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import path from "node:path";
import {
  HelloFrame,
  LiveError,
  ResultFrame,
  isHello,
  isResult,
  missingFields,
} from "../lib/protocol.js";
import { packageRoot } from "../lib/version.js";
import type { AsepriteLink, CallOptions } from "./link.js";
import type { LiveClient } from "./client.js";

/** Prefix of every line the runner means as a frame; see headless/runner.lua. */
export const FRAME_MARK = "\u001eaia ";

const DEFAULT_TIMEOUT_MS = 20_000;
/** Aseprite's batch start is ~0.4s warm; a cold first launch can take seconds. */
const DEFAULT_STARTUP_MS = 20_000;
/** Lines of stderr/stray stdout kept for the error an agent sees on a crash. */
const DIAGNOSTIC_LINES = 20;
const CLOSE_GRACE_MS = 2_000;

/**
 * Which files the user's own Aseprite window has open, or null when no window
 * is attached. Headless edits to one of those would be overwritten by the next
 * save in the window — the exact failure the project exists to prevent.
 */
export interface EditorGuard {
  openFiles(): Promise<string[] | null>;
  close(): void;
}

export interface HeadlessClientOptions {
  /** The executable to run. Null means none was found; every call refuses. */
  asepritePath: string | null;
  /** Package root holding headless/runner.lua and extension/ai-artist.lua. */
  root?: string;
  /** Working directory for the batch process; relative paths resolve here. */
  cwd?: string;
  /**
   * Aseprite user folder for the batch process. Defaults to a scratch folder
   * so a headless session never loads the user's extensions or rewrites their
   * recent-files list; an explicit ASEPRITE_USER_FOLDER is honoured.
   */
  userFolder?: string;
  /**
   * The operator enabled `lua.run` server-side. The extension gates the hatch
   * on its own environment, and this child is ours, so the flag has to reach
   * it as LIBRESPRITE_AI_ALLOW_LUA.
   */
  allowLua?: boolean;
  guard?: EditorGuard | null;
  timeoutMs?: number;
  startupTimeoutMs?: number;
  log?: (msg: string) => void;
}

interface Pending {
  cmd: string;
  expect: readonly string[];
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class HeadlessClient implements AsepriteLink {
  readonly mode = "headless" as const;

  private readonly asepritePath: string | null;
  private readonly root: string;
  private readonly cwd: string;
  private readonly userFolder: string;
  private readonly allowLua: boolean;
  private readonly guard: EditorGuard | null;
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly log: (msg: string) => void;

  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private helloFrame: HelloFrame | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private stdoutBuffer = "";
  private diagnostics: string[] = [];
  private closed = false;
  /**
   * Set when the process died between calls. The next call reports it instead
   * of quietly starting a fresh process: every document the agent was working
   * on is gone, and "sprite not found" three calls later would hide why.
   */
  private lostSession: string | null = null;

  constructor(opts: HeadlessClientOptions) {
    this.asepritePath = opts.asepritePath;
    this.root = opts.root ?? packageRoot();
    this.cwd = opts.cwd ?? process.cwd();
    this.userFolder =
      opts.userFolder ?? process.env.ASEPRITE_USER_FOLDER ?? path.join(tmpdir(), "libresprite-ai-artist-headless");
    this.allowLua = opts.allowLua ?? false;
    this.guard = opts.guard ?? null;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_MS;
    this.log = opts.log ?? (() => {});
  }

  get executable(): string | null {
    return this.asepritePath;
  }

  get bridgeConnected(): boolean {
    return this.child !== null;
  }

  get pluginConnected(): boolean {
    return this.child !== null && this.helloFrame !== null;
  }

  get hello(): HelloFrame | null {
    return this.helloFrame;
  }

  get features(): string[] {
    return this.helloFrame?.features ?? [];
  }

  hasFeature(name: string): boolean {
    return this.features.includes(name);
  }

  /** Starts the batch process if it is not running. Never throws. */
  async waitForBridge(ms = this.startupTimeoutMs): Promise<boolean> {
    return this.waitForPlugin(ms);
  }

  async waitForPlugin(ms = this.startupTimeoutMs): Promise<boolean> {
    if (this.pluginConnected) return true;
    try {
      await withDeadline(this.start(), ms);
    } catch {
      // Reported by the next call(); a readiness probe answers yes or no.
    }
    return this.pluginConnected;
  }

  async call<T = unknown>(cmd: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    if (this.closed) throw new LiveError("headless_exited", "The headless session is closed.");
    if (this.lostSession) {
      const message = this.lostSession;
      this.lostSession = null;
      throw new LiveError("headless_exited", message, { doNotFallBackToDisk: true });
    }
    await this.start();
    await this.refuseEditorFiles(cmd, args);
    return this.send<T>(cmd, args, opts);
  }

  close(): void {
    this.closed = true;
    this.guard?.close();
    this.rejectPending(new LiveError("headless_exited", "The headless session was closed."));
    const child = this.child;
    if (!child) return;
    // EOF ends the runner's read loop, so Aseprite exits on its own; the kill
    // is only for a handler that is stuck and never reads again.
    child.stdin.end();
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, CLOSE_GRACE_MS).unref();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private send<T>(cmd: string, args: Record<string, unknown>, opts: CallOptions): Promise<T> {
    const child = this.child;
    if (!child) throw new LiveError("headless_exited", "The headless Aseprite is not running.");
    const id = `h${++this.seq}`;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new LiveError("timeout", `Headless Aseprite did not answer '${cmd}' within ${timeoutMs}ms.`, {
            cmd,
            doNotFallBackToDisk: true,
          }),
        );
      }, timeoutMs);
      this.pending.set(id, {
        cmd,
        expect: opts.expect ?? [],
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });
  }

  /**
   * The one place headless mode can hurt someone: a file that is also open in
   * their Aseprite window. Checked on every command that writes an
   * `.aseprite` document or adopts one, before it runs.
   */
  private async refuseEditorFiles(cmd: string, args: Record<string, unknown>): Promise<void> {
    if (!this.guard) return;
    const targets = await this.documentTargets(cmd, args);
    if (targets.length === 0) return;
    const open = await this.guard.openFiles().catch(() => null);
    if (!open || open.length === 0) return;

    const inEditor = new Set(open.map((file) => this.normalise(file)));
    const clash = targets.find((file) => inEditor.has(this.normalise(file)));
    if (!clash) return;
    throw new LiveError(
      "file_open_in_editor",
      `'${clash}' is open in your Aseprite window. A headless edit to it would be overwritten by the next save there.`,
      {
        path: clash,
        doNotFallBackToDisk: true,
        remediation:
          "Close the file in the Aseprite window first, or work on it there: restart the server without --headless.",
      },
    );
  }

  private async documentTargets(cmd: string, args: Record<string, unknown>): Promise<string[]> {
    const pathArg = typeof args.path === "string" ? args.path : null;
    if (cmd === "sprite.manage") {
      if ((args.op === "open" || args.op === "save_as") && pathArg) return [pathArg];
      if (args.op === "save") {
        const info = await this.send<{ filename?: string }>("sprite.info", {
          sprite: args.sprite,
          includePalette: false,
        }, {});
        return info.filename ? [info.filename] : [];
      }
    }
    if (cmd === "export.run" && args.op === "aseprite" && pathArg) return [pathArg];
    return [];
  }

  private normalise(file: string): string {
    const resolved = path.resolve(this.cwd, file);
    // Both default filesystems on macOS and Windows ignore case; two spellings
    // of one file must not slip past the check.
    return platform() === "darwin" || platform() === "win32" ? resolved.toLowerCase() : resolved;
  }

  private start(): Promise<void> {
    if (this.pluginConnected) return Promise.resolve();
    if (this.starting) return this.starting;
    if (this.closed) return Promise.reject(new LiveError("headless_exited", "The headless session is closed."));

    const binary = this.asepritePath;
    if (!binary) {
      return Promise.reject(
        new LiveError("headless_unavailable", "Headless mode is on, but no Aseprite executable was found.", {
          doNotFallBackToDisk: true,
          remediation:
            "Set LIBRESPRITE_PATH to the Aseprite binary (on macOS: /Applications/Aseprite.app/Contents/MacOS/aseprite), or pass --aseprite <path> to serve.",
        }),
      );
    }

    this.starting = new Promise<void>((resolve, reject) => {
      // `ready` flips once, on hello. Before it every failure is a failed
      // start; after it an exit is a lost session. The startup timer's own
      // kill must count as the former, so this is not inferred from
      // `this.starting`, which the failure path clears.
      let ready = false;
      let settled = false;
      const settle = (err: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(startup);
        this.starting = null;
        if (err) reject(err);
        else resolve();
      };
      const startup = setTimeout(() => {
        settle(
          new LiveError(
            "headless_unavailable",
            `Headless Aseprite did not start within ${this.startupTimeoutMs}ms.${this.diagnosticTail()}`,
            { doNotFallBackToDisk: true },
          ),
        );
        this.child?.kill();
      }, this.startupTimeoutMs);
      startup.unref();

      let child: ChildProcessWithoutNullStreams;
      try {
        mkdirSync(this.userFolder, { recursive: true });
        const runner = path.join(this.root, "headless", "runner.lua");
        child = spawn(binary, ["-b", "--script-param", `root=${this.root}`, "--script", runner], {
          cwd: this.cwd,
          env: {
            ...process.env,
            ASEPRITE_USER_FOLDER: this.userFolder,
            // The extension refuses `lua.run` unless the Aseprite process
            // itself carries the switch; when the flag is on, honour it.
            ...(this.allowLua ? { LIBRESPRITE_AI_ALLOW_LUA: "1" } : {}),
          },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err) {
        settle(new LiveError("headless_unavailable", `Could not run '${binary}': ${(err as Error).message}`, {
          doNotFallBackToDisk: true,
        }));
        return;
      }
      this.child = child;
      this.stdoutBuffer = "";
      this.diagnostics = [];

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.onStdout(chunk);
        if (!ready && this.helloFrame) {
          ready = true;
          this.log(`headless Aseprite ${this.helloFrame.asepriteVersion} ready (pid ${String(child.pid)})`);
          settle(null);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => this.remember(chunk));
      // A write racing the process's death raises EPIPE here; the exit
      // handler below is what reports it.
      child.stdin.on("error", () => {});

      child.on("error", (err) => {
        if (this.child === child) this.child = null;
        settle(
          new LiveError("headless_unavailable", `Could not run '${binary}': ${err.message}`, {
            doNotFallBackToDisk: true,
            remediation: "Point LIBRESPRITE_PATH at the Aseprite executable itself, not the app bundle or a shortcut.",
          }),
        );
      });

      child.on("exit", (code, signal) => {
        if (this.child !== child) return;
        this.child = null;
        this.helloFrame = null;
        const how = signal ? `signal ${signal}` : `code ${String(code)}`;
        if (!ready) {
          settle(
            new LiveError(
              "headless_unavailable",
              `Headless Aseprite exited (${how}) before it was ready.${this.diagnosticTail()}`,
              { doNotFallBackToDisk: true },
            ),
          );
          return;
        }
        if (this.closed) return;
        const message =
          `Headless Aseprite exited (${how}). Every unsaved document in it is gone; ` +
          `reopen from disk with sprite_manage op 'open'.${this.diagnosticTail()}`;
        if (this.pending.size > 0) {
          this.rejectPending(new LiveError("headless_exited", message, { doNotFallBackToDisk: true }));
        } else {
          this.lostSession = message;
        }
      });
    });
    return this.starting;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.startsWith(FRAME_MARK)) {
        this.remember(line);
        continue;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(line.slice(FRAME_MARK.length));
      } catch {
        this.remember(line);
        continue;
      }
      if (isHello(frame)) {
        this.helloFrame = frame;
      } else if (isResult(frame)) {
        this.settle(frame);
      }
    }
  }

  private settle(result: ResultFrame): void {
    const pending = this.pending.get(result.id);
    if (!pending) return;
    this.pending.delete(result.id);
    clearTimeout(pending.timer);

    if (!result.ok) {
      const err = result.error;
      pending.reject(
        new LiveError(
          err?.code ?? "aseprite_error",
          err?.message ?? "Aseprite reported an unspecified failure.",
          // The runner loads the extension bundled with this server, so a
          // missing field is a bug here, never a stale install to update.
          err?.details ?? {},
        ),
      );
      return;
    }
    const data = result.data ?? {};
    const missing = missingFields(data, pending.expect);
    if (missing.length > 0) {
      pending.reject(
        new LiveError(
          "aseprite_error",
          `The headless runner answered '${pending.cmd}' without ${missing.map((f) => `'${f}'`).join(", ")}.`,
          { cmd: pending.cmd, missing, doNotFallBackToDisk: true },
        ),
      );
      return;
    }
    pending.resolve(data);
  }

  private remember(text: string): void {
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      this.diagnostics.push(line);
      if (this.diagnostics.length > DIAGNOSTIC_LINES) this.diagnostics.shift();
    }
  }

  private diagnosticTail(): string {
    return this.diagnostics.length > 0 ? `\nAseprite said:\n  ${this.diagnostics.join("\n  ")}` : "";
  }

  private rejectPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/** Reads which files the user's attached Aseprite window has open. */
export function editorGuard(live: LiveClient): EditorGuard {
  return {
    async openFiles() {
      if (!live.pluginConnected) return null;
      const list = await live.call<{ sprites?: { filename?: string | null }[] }>("sprite.manage", { op: "list" });
      return (list.sprites ?? []).flatMap((s) => (s.filename ? [s.filename] : []));
    },
    close: () => live.close(),
  };
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("deadline")), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

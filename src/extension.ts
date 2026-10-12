/**
 * Installing the Aseprite side.
 *
 * Aseprite loads extensions from a per-user config directory whose location
 * differs on every platform and moves between the store and standalone builds.
 * Getting this wrong is the single most common reason a setup "does nothing",
 * so the search order is explicit and `doctor` reports what it found.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { packageRoot } from "./lib/version.js";

const EXTENSION_DIR_NAME = "pixel-ai-artist";

/** Candidate Aseprite user-config directories, most likely first. */
export function asepriteConfigCandidates(): string[] {
  const home = homedir();
  const env = process.env.ASEPRITE_USER_FOLDER;
  const candidates: string[] = [];

  if (env) candidates.push(env);

  switch (platform()) {
    case "darwin":
      candidates.push(path.join(home, "Library", "Application Support", "Aseprite"));
      break;
    case "win32": {
      const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
      candidates.push(path.join(appData, "Aseprite"));
      break;
    }
    default: {
      const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
      candidates.push(path.join(xdg, "aseprite"));
      // Steam and some distro builds keep a dotfile directory instead.
      candidates.push(path.join(home, ".aseprite"));
      break;
    }
  }

  return candidates;
}

export function findAsepriteConfigDir(): string | null {
  for (const dir of asepriteConfigCandidates()) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Where an Aseprite executable usually lives when `ASEPRITE_PATH` is not set:
 * the standalone and Steam install locations, then `aseprite` on PATH.
 */
export function asepriteBinaryCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  const candidates: string[] = [];

  switch (platform()) {
    case "darwin":
      candidates.push(
        "/Applications/Aseprite.app/Contents/MacOS/aseprite",
        path.join(home, "Applications", "Aseprite.app", "Contents", "MacOS", "aseprite"),
        path.join(
          home,
          "Library",
          "Application Support",
          "Steam",
          "steamapps",
          "common",
          "Aseprite",
          "Aseprite.app",
          "Contents",
          "MacOS",
          "aseprite",
        ),
      );
      break;
    case "win32": {
      const programFiles = env.ProgramFiles ?? "C:\\Program Files";
      const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
      candidates.push(
        path.join(programFiles, "Aseprite", "Aseprite.exe"),
        path.join(programFilesX86, "Steam", "steamapps", "common", "Aseprite", "Aseprite.exe"),
      );
      break;
    }
    default:
      candidates.push(
        path.join(home, ".steam", "steam", "steamapps", "common", "Aseprite", "aseprite"),
        path.join(home, ".local", "share", "Steam", "steamapps", "common", "Aseprite", "aseprite"),
        "/usr/bin/aseprite",
        "/usr/local/bin/aseprite",
      );
      break;
  }

  const exe = platform() === "win32" ? "aseprite.exe" : "aseprite";
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  return candidates;
}

/**
 * The Aseprite executable headless mode will run, or null when there is none.
 * An explicit `ASEPRITE_PATH` that points nowhere is null, not a cue to try
 * the other locations: running a different Aseprite than the one the user
 * named would be a silent substitution they have no way to notice.
 */
export function findAsepriteBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = env.ASEPRITE_PATH ? [env.ASEPRITE_PATH] : asepriteBinaryCandidates(env);
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not there; try the next one.
    }
  }
  return null;
}

export interface InstallExtensionOptions {
  dryRun?: boolean;
  /** Override the Aseprite config directory. */
  configDir?: string | undefined;
}

export interface InstallExtensionResult {
  target: string;
  files: string[];
}

export function installExtension(opts: InstallExtensionOptions = {}): InstallExtensionResult {
  const configDir = opts.configDir ?? findAsepriteConfigDir();
  if (!configDir) {
    throw new Error(
      `Could not find Aseprite's config directory. Looked in:\n  ${asepriteConfigCandidates().join("\n  ")}\n` +
        `Run Aseprite once so it creates the directory, or pass --dir <path>.`,
    );
  }

  const source = path.join(packageRoot(), "extension");
  if (!existsSync(source)) {
    throw new Error(`Bundled extension is missing from the package at ${source}.`);
  }

  const target = path.join(configDir, "extensions", EXTENSION_DIR_NAME);
  const files = readdirSync(source);

  if (opts.dryRun) return { target, files };

  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  return { target, files };
}

#!/usr/bin/env node
/**
 * One binary, several jobs:
 *   serve              (default) speak MCP over stdio
 *   install <client…>  wire this server into an agent's config
 *   doctor             print the versions this install runs on
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { CLIENTS, ClientId, install, mergeAgentsFile, serverLaunch } from "./install.js";
import { packageVersion } from "./lib/version.js";

interface Flags {
  [key: string]: string | boolean;
}

/** Flags that never take a value, so `install --local codex` keeps `codex` a client. */
const SWITCHES = new Set(["all", "project", "local", "dry-run", "version", "help"]);
/** Flags that take the next word, unless it is a client name: `install --agents codex` installs codex. */
const VALUED = new Set(["dir", "agents"]);

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Flags; unknown: string[] } {
  const flags: Flags = {};
  const positional: string[] = [];
  const unknown: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!SWITCHES.has(key) && !VALUED.has(key)) {
      unknown.push(arg);
      continue;
    }
    if (eq !== -1) {
      flags[key] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (VALUED.has(key) && next !== undefined && !next.startsWith("--") && !CLIENTS.includes(next as ClientId)) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  const command = positional.shift() ?? "serve";
  return { command, positional, flags, unknown };
}

async function main(): Promise<void> {
  const { command, positional, flags, unknown } = parseArgs(process.argv.slice(2));

  if (unknown.length > 0) {
    process.stderr.write(`Unknown option ${unknown.map((u) => `'${u}'`).join(", ")}. See --help.\n`);
    process.exitCode = 2;
    return;
  }

  if (flags.version || command === "version") {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }
  if (flags.help || command === "help") {
    printHelp();
    return;
  }

  switch (command) {
    case "serve":
      // Plugin manifests set PIXEL_AI_PROMPTS=0; see CreateServerOptions.prompts.
      return serve({ prompts: process.env.PIXEL_AI_PROMPTS !== "0" });
    case "install":
      return runInstall(positional, flags);
    case "doctor":
      return doctor();
    default:
      process.stderr.write(`Unknown command '${command}'.\n\n`);
      printHelp();
      process.exitCode = 2;
  }
}

async function serve(opts: { prompts: boolean }): Promise<void> {
  const { server } = createServer({ prompts: opts.prompts });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => {
    // .finally() forwards a rejection, and nothing would catch it. Exit on both
    // paths explicitly rather than relying on process.exit winning the race.
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runInstall(positional: string[], flags: Flags): Promise<void> {
  const requested = positional.length > 0 ? positional : (flags.all ? CLIENTS : []);
  if (requested.length === 0) {
    process.stderr.write(
      `Name at least one client, or pass --all.\nAvailable: ${CLIENTS.join(", ")}\n`,
    );
    process.exitCode = 2;
    return;
  }

  if (flags.dir === true || flags.dir === "") {
    process.stderr.write("--dir needs a path: --dir <path> or --dir=<path>.\n");
    process.exitCode = 2;
    return;
  }

  const scope = flags.project ? "project" : "user";
  const projectDir = typeof flags.dir === "string" ? flags.dir : process.cwd();
  const dryRun = truthy(flags["dry-run"]);

  const env: Record<string, string> = {};

  let launch: { command: string; args: string[] };
  try {
    launch = serverLaunch(truthy(flags.local));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const opts = {
    scope: scope as "user" | "project",
    projectDir,
    ...launch,
    env,
    dryRun,
  };

  for (const name of requested) {
    if (!CLIENTS.includes(name as ClientId)) {
      process.stderr.write(`Unknown client '${name}'. Available: ${CLIENTS.join(", ")}\n`);
      process.exitCode = 2;
      return;
    }
  }

  let failed = false;
  for (const name of requested as ClientId[]) {
    try {
      const result = install(name, opts);
      if (dryRun) {
        process.stdout.write(`\n# ${name} → ${result.file}\n${result.note ?? ""}\n`);
      } else {
        process.stdout.write(`✓ ${name.padEnd(9)} ${result.file}${result.written ? "" : " (already up to date)"}\n`);
      }
    } catch (err) {
      process.stderr.write(`✗ ${name.padEnd(9)} ${(err as Error).message}\n`);
      failed = true;
    }
  }

  if (flags.agents !== undefined) {
    const target = typeof flags.agents === "string" && flags.agents !== "" ? flags.agents : `${projectDir}/AGENTS.md`;
    const res = mergeAgentsFile(target, dryRun);
    process.stdout.write(`${res.written ? "✓" : "·"} AGENTS.md ${res.file}\n`);
  }

  if (failed) {
    process.exitCode = 1;
  } else if (!dryRun) {
    process.stdout.write("\nRestart the agent so it picks up the new server.\n");
  }
}

function doctor(): void {
  process.stdout.write(`pixel-ai-artist ${packageVersion()}\nNode ${process.versions.node}\n`);
}

function printHelp(): void {
  process.stdout.write(
    `pixel-ai-artist ${packageVersion()} — pixel art for your coding agent

Usage:
  pixel-ai-artist [serve]                 Speak MCP over stdio (what agents run)
  pixel-ai-artist install <client…>       Write MCP config for an agent
  pixel-ai-artist doctor                  Print the versions this install runs on

Clients: ${CLIENTS.join(", ")}

Options:
  --all                Install for every supported client
  --project            Write project-scoped config instead of user-scoped
                       (with or without it, vscode writes <dir>/.vscode/mcp.json
                       and windsurf writes ~/.codeium/windsurf/mcp_config.json)
  --dir <path>         Project directory (default: cwd)
  --agents [path]      Also write an AGENTS.md section (default: <dir>/AGENTS.md)
  --local              Start this checkout's build (node …/dist/cli.js serve) instead of the npm package
  --dry-run            Print what would change, write nothing
  --version, --help

A value flag never takes a client name as its value: \`--agents codex\` installs
codex with the default AGENTS.md. Use --dir=<path> / --agents=<path> to pass a
value that looks like one.

Examples:
  node dist/cli.js install --all --local    # from a checkout, until the package is on npm
  npx pixel-ai-artist install --all --agents
  npx pixel-ai-artist install codex cursor --project
  npx pixel-ai-artist doctor
`,
  );
}

function truthy(value: unknown): boolean {
  return value === true || value === "1" || value === "true" || value === "yes";
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});

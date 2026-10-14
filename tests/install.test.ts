import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CLIENTS, configPath, install, serverLaunch, type InstallOptions } from "../dist/install.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const base = (projectDir: string, extra: Partial<InstallOptions> = {}): InstallOptions => ({
  scope: "project",
  projectDir,
  command: "npx",
  args: ["-y", "pixel-ai-artist@latest", "serve"],
  env: {},
  dryRun: false,
  ...extra,
});

const scratch = () => mkdtempSync(path.join(tmpdir(), "aia-install-"));

/** Runs the CLI with HOME pointed at a scratch directory, so no real config is touched. */
function cli(args: string[], cwd: string = scratch()) {
  const home = scratch();
  const r = spawnSync(process.execPath, [path.join(ROOT, "dist", "cli.js"), ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, home };
}

const backups = (dir: string) => readdirSync(dir).filter((n) => n.includes(".bak-"));

test("install --local points the client at this checkout's built server by absolute path", () => {
  const dir = scratch();
  // --local before the client name: a switch must not swallow the next word.
  execFileSync(process.execPath, [path.join(ROOT, "dist", "cli.js"), "install", "--local", "claude", "--project", "--dir", dir]);
  const entry = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8")).mcpServers["pixel-ai-artist"];
  assert.equal(entry.command, "node");
  assert.deepEqual(entry.args, [path.join(ROOT, "dist", "cli.js"), "serve"]);
});

test("a local install from a checkout that was never built is refused, naming the build command", () => {
  assert.throws(() => serverLaunch(true, scratch()), /npm ci && npm run build/);
});

test("without --local the client starts the published package through npx", () => {
  assert.deepEqual(serverLaunch(false), { command: "npx", args: ["-y", "pixel-ai-artist@latest", "serve"] });
});

test("opencode is a client, with an XDG-aware user path", () => {
  assert.ok(CLIENTS.includes("opencode"));
  const saved = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = "/xdg";
    assert.equal(configPath("opencode", base(scratch(), { scope: "user" })), path.join("/xdg", "opencode", "opencode.json"));
    delete process.env.XDG_CONFIG_HOME;
    assert.equal(
      configPath("opencode", base(scratch(), { scope: "user" })),
      path.join(homedir(), ".config", "opencode", "opencode.json"),
    );
    assert.equal(configPath("opencode", base("/project")), path.join("/project", ".opencode", "opencode.json"));
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
});

test("codex user scope follows CODEX_HOME, as Codex does, and falls back to ~/.codex when it is empty", () => {
  const saved = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = "/codex-home";
    assert.equal(configPath("codex", base(scratch(), { scope: "user" })), path.join("/codex-home", "config.toml"));
    assert.equal(configPath("codex", base("/project")), path.join("/project", ".codex", "config.toml"));
    process.env.CODEX_HOME = "";
    assert.equal(configPath("codex", base(scratch(), { scope: "user" })), path.join(homedir(), ".codex", "config.toml"));
    delete process.env.CODEX_HOME;
    assert.equal(configPath("codex", base(scratch(), { scope: "user" })), path.join(homedir(), ".codex", "config.toml"));
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
});

test("project scope writes the mcp.servers entry the plugin expects", () => {
  const dir = scratch();
  const result = install("opencode", base(dir, { env: { PIXEL_AI_EXTRA: "1" } }));
  assert.equal(result.written, true);
  const doc = JSON.parse(readFileSync(path.join(dir, ".opencode", "opencode.json"), "utf8"));
  assert.deepEqual(doc.mcp.servers["pixel-ai-artist"], {
    type: "local",
    command: ["npx", "-y", "pixel-ai-artist@latest", "serve"],
    environment: { PIXEL_AI_EXTRA: "1", PIXEL_AI_PROMPTS: "0" },
  });
});

test("install merges into an existing config and backs it up", () => {
  const dir = scratch();
  const file = path.join(dir, ".opencode", "opencode.json");
  const before = {
    $schema: "https://opencode.ai/config.json",
    theme: "x",
    mcp: { servers: { other: { type: "remote", url: "https://example.invalid/mcp" } } },
  };
  mkdirSync(path.join(dir, ".opencode"), { recursive: true });
  writeFileSync(file, JSON.stringify(before, null, 2));
  install("opencode", base(dir));
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.$schema, before.$schema);
  assert.equal(after.theme, "x");
  assert.deepEqual(after.mcp.servers.other, before.mcp.servers.other);
  assert.equal(after.mcp.servers["pixel-ai-artist"].type, "local");
  assert.ok(
    readdirSync(path.join(dir, ".opencode")).some((n) => n.startsWith("opencode.json.bak-")),
    "a timestamped backup exists",
  );
});

test("install defaults a non-object mcp / mcp.servers to an empty object", () => {
  for (const mcp of ["hello", { servers: 42 }]) {
    const dir = scratch();
    const file = path.join(dir, ".opencode", "opencode.json");
    mkdirSync(path.join(dir, ".opencode"), { recursive: true });
    writeFileSync(file, JSON.stringify({ $schema: "https://opencode.ai/config.json", theme: "x", mcp }));
    install("opencode", base(dir));
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(after.theme, "x", "unrelated keys survive");
    // The bad value is replaced by a real object, not spread into a character-indexed blob.
    assert.deepEqual(after.mcp.servers["pixel-ai-artist"], {
      type: "local",
      command: ["npx", "-y", "pixel-ai-artist@latest", "serve"],
      environment: { PIXEL_AI_PROMPTS: "0" },
    });
    assert.ok(
      readdirSync(path.join(dir, ".opencode")).some((n) => n.startsWith("opencode.json.bak-")),
      "a timestamped backup exists",
    );
  }
});

test("dry run returns the entry and writes nothing", () => {
  const dir = scratch();
  const result = install("opencode", base(dir, { dryRun: true }));
  assert.equal(result.written, false);
  assert.ok(result.note?.includes("pixel-ai-artist"));
  assert.equal(existsSync(path.join(dir, ".opencode", "opencode.json")), false);
});

test("dry run shows each entry under the key it is written to", () => {
  const dir = scratch();
  assert.ok(JSON.parse(install("cursor", base(dir, { dryRun: true })).note!).mcpServers["pixel-ai-artist"]);
  assert.ok(JSON.parse(install("vscode", base(dir, { dryRun: true })).note!).servers["pixel-ai-artist"]);
  assert.ok(JSON.parse(install("opencode", base(dir, { dryRun: true })).note!).mcp.servers["pixel-ai-artist"]);
  assert.ok(install("codex", base(dir, { dryRun: true })).note!.startsWith("[mcp_servers.pixel-ai-artist]\n"));
});

test("reinstalling the same entry writes nothing and leaves no new backup", () => {
  const dir = scratch();
  mkdirSync(path.join(dir, ".cursor"), { recursive: true });
  writeFileSync(path.join(dir, ".cursor", "mcp.json"), "{}");
  assert.equal(install("cursor", base(dir)).written, true);
  assert.equal(install("cursor", base(dir)).written, false);
  assert.equal(backups(path.join(dir, ".cursor")).length, 1);

  mkdirSync(path.join(dir, ".codex"), { recursive: true });
  writeFileSync(path.join(dir, ".codex", "config.toml"), "[other]\nx = 1\n");
  assert.equal(install("codex", base(dir)).written, true);
  assert.equal(install("codex", base(dir)).written, false);
  assert.equal(backups(path.join(dir, ".codex")).length, 1);
});

test("codex reinstall replaces our table and sub-tables and keeps a table whose name only starts like ours", () => {
  const dir = scratch();
  const file = path.join(dir, ".codex", "config.toml");
  mkdirSync(path.dirname(file), { recursive: true });
  const theirs = '[mcp_servers.pixel-ai-artist-extra]\ncommand = "theirs"\n';
  const other = "[other]\nx = 1\n";
  writeFileSync(
    file,
    `[mcp_servers.pixel-ai-artist]\ncommand = "old"\n\n[mcp_servers.pixel-ai-artist.env]\nOLD = "1"\n\n${theirs}\n${other}`,
  );
  install("codex", base(dir));
  const after = readFileSync(file, "utf8");
  assert.ok(after.includes(theirs), after);
  assert.ok(after.includes(other), after);
  assert.equal(after.match(/^\[mcp_servers\.pixel-ai-artist\]$/gm)?.length, 1, after);
  assert.ok(!after.includes('"old"') && !after.includes("OLD"), after);
});

test("codex treats our header with a trailing comment as ours", () => {
  const dir = scratch();
  const file = path.join(dir, ".codex", "config.toml");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '[mcp_servers.pixel-ai-artist] # mine\ncommand = "old"\n\n[other]\nx = 1\n');
  install("codex", base(dir));
  const after = readFileSync(file, "utf8");
  assert.equal(after.match(/^\s*\[mcp_servers\.pixel-ai-artist\]/gm)?.length, 1, after);
  assert.ok(!after.includes('"old"') && after.includes("[other]\nx = 1\n"), after);
});

test("a value flag does not take a client name as its value", () => {
  const dir = scratch();
  const r = cli(["install", "--project", "--agents", "codex"], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(path.join(dir, ".codex", "config.toml")));
  assert.ok(existsSync(path.join(dir, "AGENTS.md")));

  const d = cli(["install", "--project", "--dir", "codex"], dir);
  assert.equal(d.code, 2);
  assert.match(d.stderr, /--dir=<path>/);
});

test("value flags still take a path, as the next word or after =", () => {
  const dir = scratch();
  const r = cli(["install", "codex", "--project", "--dir", dir, "--agents", path.join(dir, "docs.md")]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(path.join(dir, ".codex", "config.toml")));
  assert.ok(existsSync(path.join(dir, "docs.md")));

  const other = scratch();
  const e = cli(["install", "cursor", "--project", `--dir=${other}`, `--agents=${path.join(other, "codex")}`]);
  assert.equal(e.code, 0, e.stderr);
  assert.ok(existsSync(path.join(other, ".cursor", "mcp.json")));
  assert.ok(existsSync(path.join(other, "codex")));
});

test("an unknown option is refused and nothing is written", () => {
  const dir = scratch();
  const r = cli(["install", "codex", "--project", "--bogus"], dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--bogus/);
  assert.equal(existsSync(path.join(dir, ".codex")), false);
});

test("a failed client is reported on stderr, and the restart advice is withheld", () => {
  const dir = scratch();
  mkdirSync(path.join(dir, ".cursor"), { recursive: true });
  writeFileSync(path.join(dir, ".cursor", "mcp.json"), "{ not json");
  const r = cli(["install", "cursor", "codex", "--project"], dir);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /✗ cursor .*not valid JSON/);
  assert.match(r.stdout, /✓ codex/);
  assert.doesNotMatch(r.stdout, /Restart/);
});

test("refuses to edit a config that is not JSON", () => {
  const dir = scratch();
  const file = path.join(dir, ".opencode", "opencode.json");
  mkdirSync(path.join(dir, ".opencode"), { recursive: true });
  writeFileSync(file, "not json");
  assert.throws(() => install("opencode", base(dir)), /not valid JSON/);
  assert.equal(readFileSync(file, "utf8"), "not json");
});

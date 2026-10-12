import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CLIENTS, configPath, install, type InstallOptions } from "../dist/install.js";

const base = (projectDir: string, extra: Partial<InstallOptions> = {}): InstallOptions => ({
  scope: "project",
  projectDir,
  command: "npx",
  args: ["-y", "libresprite-ai-artist@latest", "serve"],
  env: {},
  dryRun: false,
  ...extra,
});

const scratch = () => mkdtempSync(path.join(tmpdir(), "aia-install-"));

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

test("project scope writes the mcp.servers entry the plugin expects", () => {
  const dir = scratch();
  const result = install("opencode", base(dir, { env: { LIBRESPRITE_AI_HEADLESS: "1" } }));
  assert.equal(result.written, true);
  const doc = JSON.parse(readFileSync(path.join(dir, ".opencode", "opencode.json"), "utf8"));
  assert.deepEqual(doc.mcp.servers["libresprite-ai-artist"], {
    type: "local",
    command: ["npx", "-y", "libresprite-ai-artist@latest", "serve"],
    environment: { LIBRESPRITE_AI_HEADLESS: "1", LIBRESPRITE_AI_PROMPTS: "0" },
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
  assert.equal(after.mcp.servers["libresprite-ai-artist"].type, "local");
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
    assert.deepEqual(after.mcp.servers["libresprite-ai-artist"], {
      type: "local",
      command: ["npx", "-y", "libresprite-ai-artist@latest", "serve"],
      environment: { LIBRESPRITE_AI_PROMPTS: "0" },
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
  assert.ok(result.note?.includes("libresprite-ai-artist"));
  assert.equal(existsSync(path.join(dir, ".opencode", "opencode.json")), false);
});

test("refuses to edit a config that is not JSON", () => {
  const dir = scratch();
  const file = path.join(dir, ".opencode", "opencode.json");
  mkdirSync(path.join(dir, ".opencode"), { recursive: true });
  writeFileSync(file, "not json");
  assert.throws(() => install("opencode", base(dir)), /not valid JSON/);
  assert.equal(readFileSync(file, "utf8"), "not json");
});

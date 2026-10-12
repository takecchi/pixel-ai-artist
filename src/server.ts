import { readFileSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LiveClient } from "./bridge/client.js";
import { HeadlessClient, editorGuard } from "./bridge/headless.js";
import { LinkSelector } from "./bridge/selector.js";
import { findAsepriteBinary } from "./extension.js";
import { loadRules, loadSkills, serverInstructions, type RuleDoc } from "./lib/skills.js";
import { packageRoot, packageVersion } from "./lib/version.js";
import { registerAssetTools } from "./tools/assets.js";
import { registerCraftTools } from "./tools/craft.js";
import { registerDrawTools } from "./tools/draw.js";
import { registerEscapeTools } from "./tools/escape.js";
import { registerLookTools } from "./tools/look.js";
import { registerPaletteTools } from "./tools/palette.js";
import { registerSessionTools } from "./tools/session.js";
import { registerStructureTools } from "./tools/structure.js";

export interface CreateServerOptions {
  controlPort?: number;
  pluginPort?: number;
  /** Enables the run_lua escape hatch. Off unless the operator opts in. */
  allowLua?: boolean;
  /**
   * Register every workflow as an MCP prompt. Plugin installs (Claude Code,
   * omp) turn this off: they already list the skills as `/pixel-ai-artist:<name>`, and
   * the harness would add the prompts again as `/pixel-ai-artist:pixel-ai-artist:pixel-ai-artist:<name>`.
   */
  prompts?: boolean;
  autoSpawnBridge?: boolean;
  root?: string;
  /**
   * Start against a batch Aseprite this server owns instead of the user's
   * window. The session can still switch explicitly with `preflight mode=…`;
   * nothing switches on its own (ADR-0008).
   */
  headless?: boolean;
  /** Headless: the Aseprite executable. Default: ASEPRITE_PATH, then the usual install locations. */
  asepritePath?: string;
}

export interface RunningServer {
  server: McpServer;
  live: LinkSelector;
}

export function createServer(opts: CreateServerOptions = {}): RunningServer {
  const root = opts.root ?? packageRoot();
  const skills = loadSkills(root);
  const rules = loadRules(root);

  // stderr is the only channel that will not corrupt a stdio MCP session.
  const log = (msg: string) => process.stderr.write(`[pixel-ai-artist] ${msg}\n`);
  const live = new LinkSelector(
    {
      live: () =>
        new LiveClient({
          controlPort: opts.controlPort,
          pluginPort: opts.pluginPort,
          autoSpawnBridge: opts.autoSpawnBridge ?? true,
          log,
        }),
      headless: () =>
        new HeadlessClient({
          asepritePath: opts.asepritePath ?? findAsepriteBinary(),
          root,
          allowLua: opts.allowLua ?? false,
          // Watches the user's window without ever starting a bridge: its only
          // job is to refuse a headless write to a file that window has open.
          guard: editorGuard(
            new LiveClient({ controlPort: opts.controlPort, pluginPort: opts.pluginPort, autoSpawnBridge: false }),
          ),
          log,
        }),
    },
    opts.headless ? "headless" : "live",
  );

  const server = new McpServer(
    {
      name: "pixel-ai-artist",
      version: packageVersion(),
      title: "Pixel AI Artist",
    },
    {
      // Capabilities are left to the SDK to infer from what actually gets
      // registered. Declaring `prompts` by hand while no prompt exists
      // advertises a method that then answers -32601 Method not found.
      instructions: serverInstructions(skills, live.mode),
    },
  );

  registerSessionTools(server, live);
  registerLookTools(server, live);
  registerDrawTools(server, live);
  registerStructureTools(server, live);
  registerPaletteTools(server, live);
  registerCraftTools(server, live);
  registerAssetTools(server, live);
  registerEscapeTools(server, live, opts.allowLua ?? false);

  registerSkillSurface(server, root, skills, rules, opts.prompts ?? true);

  return { server, live };
}

function registerSkillSurface(
  server: McpServer,
  root: string,
  skills: ReturnType<typeof loadSkills>,
  rules: ReturnType<typeof loadRules>,
  prompts: boolean,
): void {
  // ── rules ────────────────────────────────────────────────────────────────
  server.registerResource(
    "pixel-art-rules-index",
    "rules://index",
    {
      title: "Pixel-art rulebook — index",
      description:
        "The craft rules this server encodes, by subject: core discipline, technique, colour and materials, characters (faces, hands), animation (walks, attacks), creatures, environments, objects and isometric, effects and UI, style. Read this before your first sprite in a session.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "rules://index",
          mimeType: "text/markdown",
          text:
            `# Pixel-art rulebook\n\n` +
            `Read the core files once per session, then the two or three subject files that cover what you are about to draw. ` +
            `Subject files carry \`grid\` templates you can transcribe with \`draw\` op \`grid\`.\n` +
            rulesIndex(rules) +
            `\nThese are the difference between a sprite that reads and one that looks generated.\n`,
        },
      ],
    }),
  );

  server.registerResource(
    "pixel-art-rule",
    new ResourceTemplate("rules://{name}", {
      list: async () => ({
        resources: rules.map((r) => ({
          uri: `rules://${r.name}`,
          name: r.name,
          title: r.title,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "Pixel-art rule",
      description: "One chapter of the pixel-art rulebook.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const name = String(variables.name);
      const rule = rules.find((r) => r.name === name);
      if (!rule) throw new Error(`Unknown rule '${name}'. See rules://index.`);
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: rule.body }],
      };
    },
  );

  // ── skills ───────────────────────────────────────────────────────────────
  // Exposed twice on purpose: as resources so any agent can discover and read
  // them, and as prompts so clients that render prompts get them as commands.
  server.registerResource(
    "skill",
    new ResourceTemplate("skill://{name}", {
      list: async () => ({
        resources: skills.map((s) => ({
          uri: `skill://${s.name}`,
          name: s.name,
          title: s.title,
          description: s.description,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "Workflow skill",
      description:
        "A step-by-step pixel-art workflow: what to inspect, what order to draw in, and how to check the result.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const name = String(variables.name);
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        throw new Error(
          `Unknown skill '${name}'. Available: ${skills.map((s) => s.name).join(", ")}.`,
        );
      }
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: skill.body }],
      };
    },
  );

  // Prompt names carry the same `pixel-ai-artist:` namespace the Claude Code plugin and
  // the omp extension give these workflows, so a client that turns MCP prompts
  // into slash commands (Gemini CLI, Cursor) shows `/pixel-ai-artist:draw` as well.
  for (const skill of prompts ? skills : []) {
    server.registerPrompt(
      `pixel-ai-artist:${skill.name}`,
      {
        title: skill.title,
        description: skill.description,
        argsSchema: {},
      },
      async () => ({
        description: skill.description,
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: skill.body },
          },
        ],
      }),
    );
  }

  // ── palette knowledge ────────────────────────────────────────────────────
  server.registerResource(
    "palette-presets",
    "knowledge://palettes",
    {
      title: "Bundled palette presets",
      description:
        "Every palette the `palette` tool's 'preset' op can load — about 2000, roughly 1 MB of JSON. To find one, call `palette` op 'preset' with a word of its name instead of reading this.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "knowledge://palettes",
          mimeType: "application/json",
          text: readFileSync(path.join(root, "knowledge", "palettes.json"), "utf8"),
        },
      ],
    }),
  );
}

const RULE_BANDS: Record<string, string> = {
  "0": "Core discipline",
  "1": "Technique — lines, clusters, anti-aliasing, dithering, readability",
  "2": "Colour, light and materials",
  "3": "Characters — proportions, anatomy, faces, eyes, hands, clothing, views",
  "4": "Animation — timing, idle, walk and run, jumps, attacks, secondary motion",
  "5": "Animals and creatures",
  "6": "Environments — skies, landscapes, parallax, foliage, water, tiles, buildings",
  "7": "Objects and 3D — perspective, isometric, forms, props, vehicles, rotation",
  "8": "Effects and interface — VFX, game feel, particles, UI, fonts",
  "9": "Style — platform eras, composition, tells of generated art",
};

/** The index groups rules by the first digit of their number (ADR-0011's bands). */
function rulesIndex(rules: readonly RuleDoc[]): string {
  const out: string[] = [];
  let band: string | undefined;
  for (const r of rules) {
    const digit = r.name[0] ?? "";
    if (digit !== band) {
      band = digit;
      out.push(`\n## ${RULE_BANDS[digit] ?? "Other"}\n`);
    }
    out.push(`- \`rules://${r.name}\` — ${r.title}`);
  }
  return out.join("\n") + "\n";
}

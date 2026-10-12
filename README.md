# pixel-ai-artist

Your coding agent makes pixel art with the same tools and skills as
aseprite-ai-artist — without Aseprite. Sprites live inside the MCP server and
come out as PNG and GIF files and sprite sheets you can open in any image
editor. For Claude Code, omp, Codex, Gemini CLI, Cursor and
OpenCode.

Work in progress: commands are being ported, and one that is not ported yet
answers `unsupported_command`.

## Run it

The package is **not on npm yet**. Until it is, an MCP client can start the
server straight from GitHub — npm fetches the repository, builds it once, and
caches it:

```json
{
  "mcpServers": {
    "pixel-ai-artist": {
      "command": "npx",
      "args": ["-y", "github:takecchi/pixel-ai-artist", "serve"]
    }
  }
}
```

The first start takes about ten seconds (clone, install, build); later starts
reuse npm's cache and take two or three. Pin a branch, tag or commit with
`github:takecchi/pixel-ai-artist#<ref>`. Node 22.6+ and git are required.

## Credits

A port of [with-pebbly/aseprite-ai-artist](https://github.com/with-pebbly/aseprite-ai-artist)
(MIT, Copyright (c) 2026 with-pebbly), imported at commit `dcd5a77`. The
pixel-art rulebook, skills and most of the server come from there.

## License

MIT — see [LICENSE](LICENSE).

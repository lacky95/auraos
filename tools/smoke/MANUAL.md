# Manual smoke checklist

For the owner, after `tools/smoke/run.mjs` passes. These steps change state on purpose, so run the automated test **before** them. Otherwise its state guard compares against a system that is still changing.

- [ ] **Terminal:** open a Terminal window, run a command, reload the page, and confirm the same session and output return.
- [ ] **Claude Code:** run `claude` in the Terminal, confirm you are logged in, and get one reply.
- [ ] **MCP:** in Claude Code, run `/mcp` and confirm the Terminal and Excalidraw servers are connected. Call one read-only tool, such as listing sessions.
- [ ] **Activity:** open an app window, use it, close it, and confirm the app still behaves normally.
- [ ] **Flight:** start a Flight from an app that offers one, confirm it appears, and dismiss it.
- [ ] **TerminalX embed:** open TerminalX and confirm the embedded Terminal works. **Opening this window creates a Terminal session.** Close that session afterward if you don't need it.
- [ ] **Nexus:** open Nexus, confirm the catalog loads and installed apps are listed. Don't install or update anything on the live system unless you intend to.

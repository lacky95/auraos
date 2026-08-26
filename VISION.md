# AuraOS

> **The WebOS for humans and their agents.**
> **Created with agents, curated by humans.**

A self-hosted WebOS where people and AI agents work side by side. Every tool and
agent runs sandboxed in its own container, installs like an app, composes like
Lego — and is visible in one transparent control plane. One container. Every
tool. Fully yours.

## What we're building

Not another desktop in the browser — the operating environment for the agent
era. Classic software, AI tools, and autonomous agents share one desk, under
human control. You stack any tool unchanged, give it scoped capabilities, and
let humans and agents work in the same space.

## Principles

- **Registry, not bus.** The OS is DNS and a service catalog — it connects
  things, then gets out of the data path.
- **Extend to fit, never change the base.** Any tool becomes an app through a
  thin adapter; upgrades are `docker pull`, not forks.
- **Sandbox everything.** Isolation and scoped capabilities are the default.
- **Legibility over gloss.** The UI exists to make the system understandable —
  show the machine, don't hide it.
- **Depth first.** Real apps harden the OS; breadth waits for a real need.
- **Human in the loop.** Agents do the work; humans keep the leash — at build
  time and at run time.

## Where we are

**Real today:** sandboxed apps, an app store, three-tier scopes, capabilities,
and a shared Context — env vars, secrets, and volumes — across every app.

**Next:** an Interface Registry so apps and agents discover and compose each
other's interfaces (REST, MCP, WebSocket, streams), on-demand activation, and
autonomous agents running as first-class apps.

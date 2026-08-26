# Shipping the desk: projects as a distributable artifact

Status: **idea / design sketch** (2026-08-26). Nothing here is built. Companion
to [agents.md](./agents.md) — that one is about who does the work, this one is
about what the work arrives in.

---

## The claim

Today you ship **code**, and the environment is reconstructed by convention:
a README, a CI config, a devcontainer, a page in Notion, and someone on Slack
explaining what else you need installed.

The proposal is to invert it: **ship the working environment as the artifact,
and treat code as one of its inputs.** A project is not a repo — it is the
apps, the tools granted, the volumes, the context keys, the layout, and the
agents that work on it. All of that is already modelled in AuraOS as separate
nouns. What is missing is the object that composes them.

The strong version of the claim, which is the interesting one:

> **A project arrives with its own maintainers.** `aura install
> project://acme/api` gives you the code, the desk, *and* the reviewer agent
> and the deploy agent — sandboxed, with declared grants, ready to work.

Nobody ships permissions, agents, apps and code as one artifact.

## A project is a composition, not a new primitive

Everything a project needs already exists as an OS noun. The project manifest
is a *manifest of manifests*:

| ingredient | already exists as |
|---|---|
| code | volume (or a repo pinned into one) |
| apps | app packages, installed per scope, published as OCI via Nexus |
| tools | capabilities (`aura cap install` / `grant`) |
| secrets | Context — declared keys, values bound locally |
| storage | OS-managed Volumes |
| window layout | workspaces + layout strategies |
| workers | agents (see agents.md) |

That matters for scope: this is not a new subsystem, it is **one new object
plus a resolver**. If it starts needing its own runtime, something has gone
wrong.

### Sketch

```yaml
# project.yaml
id: com.acme.api
name: Acme API
version: 3.2.0

code:
  - volume: api-src
    git: https://github.com/acme/api
    rev: 9f3c1a2            # pinned, not a branch

apps:
  - com.aura.terminal@2.1.0
  - com.aura.console@1.4.2
  - com.aura.notepad@1.0.9

tools: [git, rg, node, docker]

context:                      # declared, never carried
  required: [DATABASE_URL, GITHUB_TOKEN]
  optional: [SENTRY_DSN]

volumes:
  - name: api-data
    size: 10Gi

agents:
  - use: com.acme.reviewer/reviewer
    workspace: worktree(api-src)
    mandate: { scope: [volume:api-src], budget: { calls: 200, per: day } }

setup:
  - run: pnpm install
    in: api-src

layout:
  workspace: dev
  windows: [terminal, console, notepad]
```

## Three verbs: setup, develop, maintain

**Setup** — `aura project install acme/api`. The OS resolves the bundle,
installs the apps, creates the volumes, clones the code at the pinned rev,
prompts for the required context keys, applies the grants, and opens the
layout. One command, and a new machine has the same desk as everyone else.

**Develop** — humans and agents work in the same desk. This is where agents.md
takes over: agents bound to the project, sandboxed to its volumes, proposing
diffs, with take-over when a human wants the keyboard.

**Maintain** — the loop already proven by self-update: fetch a newer version,
apply it, health-check, roll back if it does not come up. Pointed at a project
instead of the OS, that is *reconciliation*: install/remove apps, re-pin code,
migrate volumes, adjust grants. GitOps for desks.

The third verb is the one people underrate. Setting an environment up once is
a solved-ish problem. Keeping fifty of them identical, updated and recoverable
is not.

## Reproducibility is the load-bearing weakness

Ship-the-desk is only credible when **two installs of the same version are
provably the same desk**. AuraOS is not there:

- `pnpm install` runs at container boot
- dev mode everywhere; the image is built from a working checkout
- apps resolve by name and version, not by digest
- capabilities install from apt/npm/curl at whatever version is current today

A ladder to climb, roughly in value order:

1. **Pin app versions** — already possible via Nexus/OCI, not enforced.
2. **Pin capabilities** — a version per registry entry, not "latest apt".
3. **Pin base images** by digest.
4. **A `project.lock`** — resolve once, record every digest, install from the
   lock thereafter. This is the step that turns "should be the same" into "is
   the same".
5. **Content addressing end to end** — the bundle digest identifies the desk.

Step 4 is where the credibility lives. Until it exists, this is a nicer
devcontainer; after it, it is a distribution format.

## Distribution: reuse Nexus

A project bundle is just another OCI artifact — the same road apps already
take (`oras`, zot, the Nexus manager). No new registry, no new protocol, and
signing/provenance come along for free from OCI.

Which also means projects can be **private, versioned, and rolled back** with
machinery that already exists.

## Where agents fit

The two sketches meet here, and the join is small:

- A project **declares which agents work on it**, and with what mandate —
  scope limited to the project's volumes, budget per day, escalation rules.
- Installing the project **binds** those agents (agents.md §4): grants become
  the intersection of what the agent may do and what the project permits.
- Agent tasks run in **worktrees of the project's code volume**, and come back
  as diffs against it.
- The project's activity log answers *what has been done to this project, by
  whom (human or agent), on whose behalf.*

An onboarding story falls out for free: a new person — or a new agent — joins
by installing the project. There is no separate "and now configure your agent"
step, because the team is part of the artifact.

## What exists today vs what is missing

**Exists** (verified, not assumed): app packages and installs, scopes with git
repos per scope, OS-managed volumes, Context with encrypted values, capability
registry + grants, OCI publish/pull via Nexus, workspaces and layout
strategies, and a self-update loop that fetches, rebuilds, health-checks and
rolls back.

**Missing**: the project object itself; a resolver; a lock file; volume
migration between versions; per-project activity logs; and everything in
agents.md.

That inventory is the reason this looks reachable rather than fantastical —
most of it is composition, and the genuinely new parts are the lock file and
the reconciler.

## Why this is not devcontainers, Nix, or Compose

- **Devcontainers / Codespaces** — one container, dev-only, per repo. No app
  model, no persistent desk, no identity, no agents. It reconstructs a *build
  environment*, not a workplace.
- **Nix** — genuinely reproducible, and the sharpest competition on that axis.
  But it describes a *system closure*, not a running desk: no windows, no
  running apps, no agents, no grants, and a learning curve most teams refuse.
- **Compose** — orchestrates services. There is no user, no session, no
  workspace, nothing to work *in*.

The gap all three share: none of them ship **who may do what**. The desk
includes its permissions and its workers, and that is the part that cannot be
bolted on afterwards.

## Risks and open questions

- **Secrets.** Bundles declare key *names*, never values. Binding happens at
  install time, locally. Getting this wrong once poisons the whole idea.
- **Trust.** Installing a bundle runs setup steps — arbitrary code. Signing and
  provenance are table stakes before anything is installed from a stranger.
- **Volume data migration.** Moving from v3.1 to v3.2 when a volume's schema
  changed is the hardest unsolved piece. Possibly out of scope: projects
  reconcile *structure*, and data migration stays the app's job.
- **Where does the checkout live** — an OS volume (portable, snapshot-able,
  agent-friendly) or a host bind (familiar, editable with local tools)? Both
  have obvious pull; picking one shapes everything downstream.
- **Same project on two machines** — laptop and server. Same desk, separate
  state? Shared state? Out of scope for v1, but the answer changes the model.
- **First-install latency.** A desk is heavier than a repo. Layer caching and
  a warm base image matter more here than they look.
- **Drift.** Someone installs an extra app, grants an extra tool. Does the
  project detect it, reconcile it away, or record it? A desk that silently
  diverges is a desk you cannot trust to be identical.

## The cheapest test of the whole thesis

Dogfood it on this repo, before building any of the above properly:

1. Hand-write `project.yaml` for AuraOS itself — apps (terminal, console,
   notepad), tools, the checkout volume, the context keys.
2. Install it on a second machine and see whether the desk is genuinely the
   same. Every difference found is the real backlog, and it will not be the
   backlog anyone would have guessed.
3. Add one agent to the bundle, let it do one real task in a worktree, and
   `aura jump` into it mid-task.

If step 2 is boring and step 3 feels good, this is a product. If step 2 turns
up twenty differences, the lock file moved to the top of the list and that is
worth knowing before writing a resolver.

## Deliberately not yet

- A project *marketplace* or discovery UI
- Multi-machine sync of project state
- Data migration tooling between versions
- Templating or inheritance between project manifests (this is where a config
  language will try to grow — resist)
- Anything that makes a project a runtime rather than a manifest

## The trap

The same one as agents.md, wearing a different hat: it is tempting to build
the resolver, the lock format and the reconciler *before* one project has ever
been installed twice. The order that keeps this honest is the reverse — install
one by hand, feel what breaks, then automate exactly that.

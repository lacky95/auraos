# Agents as a first-class object in AuraOS

Status: **idea / design sketch**. Nothing here is built. Written up from a
design conversation (2026-08-26) so the reasoning survives — not a plan of
record, and two of its claims are untested (see *Assumptions to test*).

Companion: [shipping-projects.md](./shipping-projects.md) — this sketch is
about who does the work, that one is about what the work arrives in.

The starting observation, from building Hermes as an app: an agent app *works*
— Hermes gave real orchestration and a dashboard out of the box — but it never
feels native. The app is the shipping vehicle. The agent is something else, and
AuraOS has nowhere to put it.

The second observation, which reshaped the whole sketch: agents come in **two
shapes**. A prompt-driven agent that is called, works, and finishes. And an
*autonomous* one (Hermes, OpenClaw, whatever CLI agent appears next) that runs
continuously and decides its own work. Both have to feel native. Designing only
for the first one is the easy mistake.

---

## 1. Agent is the third component type

Manifests already say `componentType: 'activity' | 'service'`. That is exactly
this pattern: **the app is the package; the OS knows the component types the
package declares and owns their lifecycle.** Android does it with
Activities/Services/Providers, macOS with extensions and login items,
Kubernetes with CRDs.

So `agent` is not a new architectural concept here. It is the third component
type — the first one that needs an *identity*.

## 2. Two modes, mirroring activity and service

The split already made for apps applies unchanged to agents:

|                | invoked by                          | lifetime               | produces                  | app analogue |
|----------------|-------------------------------------|------------------------|---------------------------|--------------|
| **Task agent** | a call with a goal                  | bounded                | outcome + diff            | activity     |
| **Resident agent** | triggers, schedule, own judgement | supervised, long-running | action stream + proposals | service      |

Same Agent object, a `mode` field. Residents inherit something valuable for
free: **the app lifecycle already fits them** — `onStart/onStop/onPause/
onResume`, autoStart, health checks, adoption after a shell restart. Hermes as
a service app already gets all of that today. What it does *not* get is
identity, per-principal grants, audit, budget, and any way for the OS to see
into its work.

## 3. App : Instance :: Agent : Task

The symmetry to build on, because the machinery and the mental model exist:

|        | ships as                | runs as                                   | OS owns                                   |
|--------|-------------------------|-------------------------------------------|-------------------------------------------|
| App    | package                 | **Instance** — sandbox, port, lifecycle   | registry, spawn, grants, adoption         |
| Agent  | declared *by* a package | **Task** or **Residency** — sandbox, workspace, record | registry, spawn, grants, audit, take-over |

An **Agent** is a declaration: identity, grants, how it is invoked or triggered.
A **Task** is one bounded execution. A **Residency** is a supervised
long-running one.

Everything built for App→Instance transfers: AppManager's shape, the job-file
pattern, `aura jump`, the permission system.

## 4. Agents are consumable: apps bind to them

This is the other half of why an agent must not simply *be* an app. An app is a
**package** — a thing you ship and install. An agent is a **provider with an
identity** — a thing you bind to and call. Packaging and usage are different
axes, and conflating them is what makes an agent app a silo: Hermes ships
agents, but nothing else in the OS can pick one up and use it.

The goal: **any app can use an agent**, the same agent can serve many apps, and
each of them gets it in a different shape.

### It is a grammar AuraOS already uses

| noun           | declaration        | per-consumer step    | materialised as        |
|----------------|--------------------|----------------------|------------------------|
| Capability     | registry entry     | `tools[]` grant per app | allowlist dir in the instance |
| App            | manifest           | install per scope    | instance               |
| **Agent**      | agent declaration  | **binding** per consumer | **task / session**  |

So this needs **no new layer between apps and capabilities** — one new noun
(Agent) and one new relation (*uses* / binding). Registry, grants, per-consumer
materialisation and instancing are all machinery that exists twice already.

### Why it is still not a capability

> **A capability is a verb. An agent is an actor.**

`rg` has no identity, no judgement, no state and no budget; it does exactly what
it is told. An agent decides things, spends money, and acts over time. Granting
`rg` to an app grants a verb. Granting an agent grants *something that can use
verbs on your behalf* — which is why the grant model has to differ.

### The real question: whose authority applies?

When App A calls Agent X, which grants are in force?

1. **The agent's own** — X acts with its principal's powers regardless of who
   asked. Simple, but any app that may call X inherits X's reach.
2. **The caller's** — X is confined to what A may do. Safe, but then X cannot
   hold capabilities A lacks, which removes much of the point.
3. **The intersection, with explicit escalation** — X may do what *both* it and
   A are permitted; anything beyond raises the escalation prompt.

**Default to 3.** It is the only one where "I gave the notepad app a reviewer
agent" cannot quietly become "the notepad app now has GitHub write access", and
escalation turns the remaining cases into a decision someone actually sees.

### The binding is the "shape"

Same agent declaration, different grants, workspace and config per consumer —
exactly the way one capability is granted differently to different apps. The
binding carries the grant set and a config reference. Nothing else.

Keep the binding **flat and boring**. Complexity will try to accumulate here
first: overrides, defaults, inheritance, per-instance variants. If a binding
ever needs a *resolver*, that is the signal it is being overengineered.

### Dual attribution

A task record should carry **two identities**: the agent principal (*who did
it*) and the requester (*who asked* — an app, or a human). Nearly free to
record, and it is what makes the audit trail meaningful: "the reviewer agent
modified this file, on behalf of the docs app, triggered by the nightly
schedule."

### Minimal v1

```json
// provider app — ships the agent
"agents": [{ "id": "reviewer", "mode": "task", "runtime": "claude-code" }]

// consumer app — declares that it wants to use it
"uses": { "agents": ["com.acme.reviewer/reviewer"] }
```

```js
const reviewer = await aura.agents.get('com.acme.reviewer/reviewer');
const task     = await reviewer.run({ goal, workspace });
```

The OS does four things: check the consumer may bind, compute the grant
intersection, spawn the task under the agent's principal, record it with dual
attribution. No profiles, no marketplace, no capability graph, no policy DSL.

An agent-only package needs no new packaging either — it is a service app with
no UI that declares agents.

### Deliberately not yet

- Profiles or variants of an agent beyond what the binding carries
- Agent-to-agent binding (let *residents spawn tasks* cover it first)
- Any policy language — mandates stay plain fields, not expressions
- Versioning and compatibility of agent interfaces (the Interface Registry can
  absorb that later)

### Why this is the bigger idea

It makes agents **composable infrastructure rather than destinations**. Today an
agent is a place you go — Hermes' dashboard. Bound this way it becomes something
any app picks up: the notepad gets a summariser, the terminal gets a fixer,
nexus gets a package auditor — one agent object, bound differently, every use
sandboxed and audited by one mechanism.

That is a much larger claim than "AuraOS runs agents", and it is the version
people would build *on* rather than merely use.

## 5. Identity: principals, not users

An agent should not be an app (apps have no identity, cannot own data, cannot
be blamed) and does not need to be a *user* in the human sense (logins,
tenancy, auth screens).

What is needed is a **principal**: an identity that owns a home, holds grants,
and is attributable. Humans and agents are the same kind of thing under this
model, differing only in origin.

Half of it exists already: `/data/aura/home/<id>`, keyed by id, with `default`
as the first principal. What is missing is that **grants hang off the app
manifest rather than off whoever is running it**.

This kills the "we need multi-user first" blocker: multi-user is not a
prerequisite for agents, **it is the same feature**. Build principals, get both.
Skip auth entirely — local principals need no passwords. Defer that until
something remote needs in.

Naming sketch: `agent:com.acme.reviewer/reviewer`.

## 6. Agents do not log in — the OS mints them a session

Humans log in interactively (`claude login`, `gh auth`). An agent cannot and
should not.

The mechanism already exists: **Context**. Encrypted secrets, injected as env or
`/run/context/<KEY>`, declared per manifest.

So the flow inverts. The agent does not authenticate to the OS; **the OS gives
it a session carrying exactly the credentials its manifest declared and the user
approved.** Capability-based rather than credential-based.

Revocation becomes real: stop injecting, kill the session. No token to rotate,
no logout to forget. For a resident this is the kill switch.

Install-time UX — the App Store model applied to agents:

> `com.acme.reviewer` wants: `git`, `rg`, `node` · context: `GITHUB_TOKEN` ·
> volume: `project:api` (read-write) — **Allow?**

## 7. Mandate: the object autonomy actually needs

A task gets a goal. A resident needs **standing authority with limits** — this
is the genuinely new object, and the difference between "an agent I called" and
"an agent that acts while nobody is watching":

- **scope** — which volumes, projects, interfaces it may touch
- **budget** — tokens / money / tool calls, per window
- **window** — until when; mandates expire rather than living forever
- **escalation rules** — what it must ask about instead of deciding
- **breaker** — what trips it off automatically (budget exhausted, N failures,
  a forbidden path touched)

Nothing in AuraOS models this today, and nothing in the agent ecosystem models
it well. It is the thing that makes leaving an agent running a considered
decision rather than a leap of faith.

## 8. Triggers: what wakes a resident

Declared in the manifest, so "what causes this agent to act" is inspectable
instead of buried inside the agent's own loop:

- a schedule
- an OS event (`OsEventBus`, `kv:changed`, lifecycle events — the substrate is
  already there)
- a file/volume change
- an inbox message, from a human or another agent

## 9. Two runtime flavours

The real cases differ, so allow both:

- **`runtime: "self"`** — the app ships the whole thing (Hermes, OpenClaw). The
  OS spawns it in a sandbox with grants and a workspace and receives whatever it
  reports. The agent keeps its own brain.
- **`runtime: "claude-code"`** (an OS-provided runtime) — the app ships only a
  *configuration*: model, prompt/skills, MCP servers, tools. The OS executes it.

The second is where the leverage is: shipping an agent becomes shipping a
manifest and a prompt directory, exactly like declaring a service.

```json
{
  "id": "com.acme.reviewer",
  "agents": [{
    "id": "reviewer",
    "mode": "task",
    "runtime": "claude-code",
    "skills": "./agents/reviewer/skills",
    "mcp": "./agents/reviewer/mcp.json",
    "tools": ["git", "rg"],
    "context": ["ANTHROPIC_API_KEY"],
    "workspace": "worktree",
    "provides": ["review.diff"],
    "consumes": ["vcs.git"]
  }, {
    "id": "maintainer",
    "mode": "resident",
    "runtime": "self",
    "entrypoint": "./agents/maintainer/run.sh",
    "triggers": [
      { "on": "schedule", "cron": "0 * * * *" },
      { "on": "event", "topic": "vcs.push" }
    ],
    "mandate": {
      "scope": ["volume:project-api"],
      "budget": { "calls": 200, "per": "day" },
      "expires": "2026-12-31",
      "escalate": ["docker", "network.write"]
    }
  }]
}
```

## 10. The invocation contract

For tasks, minimally:

- **In:** goal, workspace path, context, grants, task id.
- **Out:** a stream of events — step started, tool called, output,
  question-for-human, finished.
- **End:** an outcome + a diff.

This shape is already built once, in the self-updater: durable record, step
checklist, live transcript, explicit acknowledgement at the end, readable by a
*different process* after the original died. Reuse it rather than reinventing.

For residents the same event stream applies, but there is no terminal outcome —
it becomes a **continuous activity log per principal**, answering *what has this
thing been doing for the last three days?* Plus a **proposal inbox**: autonomous
does not mean unreviewed, it means reviewed *asynchronously*. The agent
proposes, work queues, a human accepts or rejects later.

## 11. Workspace isolation — the genuinely hard part

Sandboxing an app is easy: it gets its own dir. Sandboxing an agent that must
edit *your project* is the real problem, because write access to real code is
the entire point.

Proposal: **an agent never works in the live checkout.** It gets a git worktree
or a volume snapshot; work happens in isolation; what comes back is a **diff to
accept or reject**. Volumes are already an OS concept, so a task workspace is an
extension rather than a new idea.

This is what makes agent work safe without trusting the agent — and it composes
with take-over: `aura jump` into the running task, inspect it in its own
worktree, hand it back.

## 12. The spawn rule

> **Residents may spawn tasks. Tasks may not spawn anything.**

This gives Hermes exactly what it needs — a resident whose job is spawning and
coordinating bounded tasks — while making runaway recursion structurally
impossible. Orchestration lives with residents; tasks stay leaves.

## 13. Composite packages, and agents that spawn agents

Hermes is the case that breaks a tidy model, so the model has to answer it:
it is **an app and an agent at once** — it serves its own dashboard, *and* it
is an orchestrator that spawns further containers which are themselves agents.

### One package, several components

The first half needs nothing new. A package declares components; Hermes
declares an activity (the dashboard) and a resident agent (the orchestrator).
That is the same manifest shape as an app that ships an activity and a service.

The part that matters is what the dashboard *reads*. Today it renders Hermes'
private state, which is why it feels like a parallel universe. If it renders
the **OS registry** — agents, tasks, activity, proposals — then it becomes a
lens rather than a database, and three things follow: the OS's own Agents view
shows the same truth, other apps can render it too, and Hermes stops being the
only way to see what its agents did.

> **The dashboard is a lens, not a database.**

### Sub-agents: the actual problem

Hermes spawns containers today with its own docker access. From the OS's point
of view those workers do not exist: no principal, no grants, no audit, no
take-over, no kill switch. They are invisible children of a visible parent —
and the reason they can exist at all is that Hermes holds the docker socket,
which is root on the host.

So `spawnTask()` is not a convenience API. **It is what lets an agent app give
up the docker socket.** The OS creates the sandbox, applies the grants, records
the task, and hands back a handle. Hermes keeps every bit of its orchestration
logic and loses only the privilege it should never have had.

### Delegation with attenuation

Hermes generates workers dynamically — they cannot all be pre-declared in a
manifest, and forcing that would break what makes it useful. The rule that
handles this without inventing anything:

> **A resident may spawn tasks with at most its own authority.**

Straight from process semantics: a child inherits, may drop privileges, and can
never gain them. Which gives two clean kinds of agent:

- **Declared agents** — in a manifest, installed, bound by consumers (§4).
  Static, inspectable, reusable.
- **Delegated tasks** — spawned at runtime by a resident, grants ⊆ parent's,
  attributed to the parent, recorded like any other task. No declaration
  needed, because they can never exceed something already approved.

Anything Hermes wants a worker to do that exceeds Hermes' own mandate is not a
new kind of object — it is an **escalation prompt** (§15).

### What follows from it

- **Depth is bounded at two by construction.** Residents spawn tasks; tasks
  spawn nothing (§12). User → Hermes → workers, and no deeper. If a worker ever
  legitimately needs to orchestrate, that is a resident, and it needs its own
  mandate.
- **Budget flows down the tree.** A sub-task debits the parent's budget, or
  budgets mean nothing. Hermes' mandate is the ceiling for everything beneath
  it.
- **The kill switch cascades.** Stopping a resident stops its tasks — possible
  only because the OS owns the sandboxes rather than the parent.
- **Attribution is a chain**, not a pair: *task W, spawned by Hermes, on behalf
  of the docs app, triggered by the nightly schedule.*

### A migration path that does not require rewriting Hermes

This is the point of the nativeness ladder (§14) — it can be climbed one rung
at a time:

1. **As-is.** Hermes spawns its own containers. The OS sees one service app.
   Workers are invisible; the socket stays. Level 0–1.
2. **Report.** Hermes tells the OS about the workers it created — ids, goals,
   status. They become visible, auditable and listable, though the OS still does
   not control them. Level 2–3. Cheap, and it is the rung that makes the
   dashboard-as-lens possible.
3. **Delegate.** Hermes calls `spawnTask()` instead of docker. The OS owns the
   sandboxes; grants, budget, cascade-kill and take-over all start working; the
   docker socket goes away. Level 5.

Step 2 is worth doing even if step 3 never happens — visibility without control
is still far better than a black box, and it is a change to Hermes' logging
rather than its architecture.

## 14. Nativeness is a ladder, not a flag

For `runtime: self` agents the OS cannot see inside the loop, so "native" cannot
be something the manifest declares. It is **measured by how much the agent
reports through OS channels**:

| level | the agent…                | it gets…                                  |
|-------|---------------------------|-------------------------------------------|
| 0     | runs in a sandbox         | grants, isolation, take-over              |
| 1     | registers its agents      | appears in the system Agents view         |
| 2     | reports activity          | OS-owned audit, "what has it been doing"  |
| 3     | proposes diffs            | review inbox, safe unattended work        |
| 4     | asks for permission       | dynamic grants, escalation prompts        |
| 5     | spawns OS tasks           | its sub-agents become OS objects too      |

The practical route for Hermes is not a rewrite: give `@aura/app-sdk` an agent
surface — `agent.report()`, `agent.propose(diff)`, `agent.ask(grant)`,
`agent.spawnTask()` — and let Hermes map its internal events onto those calls,
climbing the ladder incrementally.

This is also the defence against the moving target: **more autonomous CLI agents
will keep appearing.** Chasing each one's internals does not scale. Defining the
contract and letting them meet it does. An agent that adopts the SDK is native
on day one; one that does not still runs, just opaquely, at level 0.

## 15. What this does for Hermes

The mechanics are in §13; this is what changes about its *position* in the
system. Hermes stops being a parallel universe and takes up three native roles
at once, from one package:

1. **Provider** — its agents are registered in the OS registry, appearing in
   the system Agents view alongside everyone else's, with the same grants,
   audit and take-over.
2. **Orchestrator** — a resident that spawns tasks, and that can *consume*
   agents it did not ship (via the Interface Registry's `provides`/`consumes`).
   Its scheduling brain keeps all its value and gains a larger pool to
   schedule over, including Claude Code agents.
3. **Lens** — its dashboard renders OS state rather than owning it.

The thing to notice: none of that removes anything from Hermes. It loses the
docker socket and its private registry; it keeps the orchestration logic, which
was always the valuable part.

**The state lives in the OS, the app renders it.**

## 16. The primitives nobody else has

- **Escalation as a system prompt.** The agent hits a wall and asks —
  *"reviewer wants `docker` for this task. Allow once / always / deny"* — and the
  OS asks the human, like a mobile permission dialog. Grants become dynamic
  instead of decided up front.
- **Take-over into a live session.** Already ~80% built for terminals; it is the
  handoff mechanism between agent and human and nobody else has it.
- **Supervision of unattended work** — mandate, budget, breaker, kill switch,
  activity log.

Everyone can run an agent in a container. Almost nobody is building the layer
that lets you *let it run*. If AuraOS is the place where autonomous agents are
safe to leave running, that is a category of one — and a much stronger claim
than "sandboxed dev environment".

---

## Open questions

- **Where do grants live** when an app and its agent disagree — answered in §4
  (intersection plus escalation), but untested: the intersection may turn out
  too narrow to be useful in practice, e.g. an agent that legitimately needs
  network access a caller lacks.
- **Does a binding need its own identity?** A task under "agent X on behalf of
  app A" is attributable, but if A binds X twice with different grants, the two
  bindings need distinguishing somehow.
- **What happens to running tasks when a binding is revoked** mid-flight —
  killed, or allowed to finish under the old grants?
- **Can a delegated task be promoted to a resident?** Hermes may well want a
  worker that itself orchestrates. §12 forbids it; if that turns out to be a
  real need rather than a hypothetical, the depth-2 rule is what gives.
- **How does a resident describe a worker it invents at runtime** well enough
  for a human to judge it in the Agents view — a goal string, or something
  structured?
- **What does work cost?** No budget, quota or metering concept exists today,
  and mandates depend on one.
- **Who owns the proposal inbox UI** — a system surface, or an app that renders
  OS state?
- **Can a resident hold multiple concurrent activities**, or is it one at a
  time with a queue? Affects supervision and take-over a lot.
- **What happens to in-flight work when a mandate expires** mid-task?

## Assumptions to test

- That the self-updater's job-file shape really fits an agent task. It looks
  right (durable, step-wise, transcript, survives its process) but it has only
  ever carried a build.
- That worktree-plus-diff is workable for agents that need to run builds,
  servers or tests inside their workspace — not just edit files.

## How to de-risk this

Do not design the Agent object abstractly. **Extract it from the real cases**:
write the manifest Hermes wishes it had, the one OpenClaw would need, and the one
for a Claude Code reviewer. Whatever all three need is the object; everything
else is v2.

If Agent v1 is only `{ id, mode, runtime, tools, context, workspace }` plus a
task record, that is a fine v1 — already more than any competitor offers.

The trap is building the full ontology (roles, teams, policies, capability
graphs) before a single agent has done one real task end to end.

## Rough build order

1. **Principals** — generalise the id that already exists; grants become
   "principal × app". Small; homes are already keyed by id.
2. **Task record** — reuse the updater's job-file pattern verbatim. Small, and
   immediately gives observability.
3. **Task workspace** — worktree/snapshot + diff-based acceptance. Medium,
   highest safety payoff.
4. **Agent install flow** — agent = app + principal + declared grants/context,
   approved at install. Medium.
4b. **Binding** — a consumer app declares `uses.agents`, the OS computes the
   grant intersection and mediates the call (§4). Small once 1–4 exist, and it
   is what turns agents from destinations into infrastructure.
5. **Take-over into a task** — mostly built already.
6. **Resident mode** — triggers, activity log, proposal inbox. Do this once one
   task agent has worked end to end; residents are strictly harder and every
   piece above is a prerequisite.
7. **Mandates and supervision** — budget, breaker, kill switch. The moment any
   resident runs unattended, this stops being optional.

## The trap worth naming

It feels like every step toward agents requires more base OS work first. Flip
it: **the base features needed for agents are the product.** Principals, grants,
sessions, audit, isolated workspaces, supervision — that is not a tax on the way
to the interesting part, that *is* the interesting part.

The actual trap is base OS work that is *not* on this path — more layout
strategies, more window management, more polish on the desktop metaphor. Those
feel like progress because they are visible and finite, and they are what
quietly eats a year.

Test for anything about to be built: **does this let an agent do something
safely that it could not do before?**

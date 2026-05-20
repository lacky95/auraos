import Link from 'next/link';
import { Cards, Card } from 'fumadocs-ui/components/card';
import { Callout } from 'fumadocs-ui/components/callout';

// AuraOS landing page. Built from fumadocs-ui primitives so theme, type, and
// layout match the rest of the docs site automatically. The hero text is the
// project vision verbatim — same string appears at the top of
// content/docs/introduction.mdx, so the landing and intro reinforce each
// other without paraphrase drift.
export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col gap-12 px-6 py-16 max-w-5xl mx-auto w-full">
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="flex flex-col items-center text-center gap-6">
        <pre
          className="font-mono text-[color:var(--aura-color-primary)] leading-tight select-none"
          style={{ textShadow: 'var(--aura-glow-primary)' }}
          aria-hidden
        >
{`╔══════════════════════════════════════════════════╗
║                    A U R A O S                   ║
╚══════════════════════════════════════════════════╝`}
        </pre>

        <p className="max-w-3xl text-fd-foreground/90 text-base sm:text-lg">
          <strong className="text-fd-foreground">AuraOS — the OS for everywhere.</strong>{' '}
          Phone, desktop, TV, AR, VR — one coherent surface, any device, any input.
          Apps live in their own Docker sandboxes with activities, and every
          layer is open for builders to extend, remix, and shape into whatever
          comes next.
        </p>

        {/* CTAs sized to their text so they read as buttons, not narrow
            cards. flex-wrap so they stack on phone-width iframes instead
            of getting squished into two skinny columns. */}
        <div className="mt-2 flex flex-wrap gap-3 justify-center">
          <Link
            href="/docs/introduction"
            className="inline-flex items-center px-5 py-2 font-mono text-sm uppercase tracking-widest border border-[color:var(--aura-color-primary)] text-[color:var(--aura-color-primary)] hover:bg-[color:var(--aura-color-primary)] hover:text-[color:var(--aura-color-bg)] transition-colors"
            style={{ boxShadow: 'var(--aura-glow-primary)' }}
          >
            [ READ INTRODUCTION ]
          </Link>
          <Link
            href="/docs/quick-start"
            className="inline-flex items-center px-5 py-2 font-mono text-sm uppercase tracking-widest border border-[color:var(--aura-color-border)] text-[color:var(--aura-color-text)] hover:border-[color:var(--aura-color-primary)] hover:text-[color:var(--aura-color-primary)] transition-colors"
          >
            [ QUICK START ]
          </Link>
        </div>
      </section>

      {/* ── Feature grid ─────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <h2 className="text-xs uppercase tracking-[0.3em] text-fd-muted-foreground">
          // Explore
        </h2>
        <Cards>
          <Card
            title="Architecture"
            description="Shell + proxy + sandboxed apps in iframes. One diagram, two layers."
            href="/docs/core-concepts"
          />
          <Card
            title="Develop an App"
            description="Scaffold in 30 seconds with `aura dev new`, then jump into the sandbox."
            href="/docs/develop-an-app"
          />
          <Card
            title="Develop in the Sandbox"
            description="Use the Terminal app + aura jump + Claude Code from inside the running app."
            href="/docs/develop-in-sandbox"
          />
          <Card
            title="Core Concepts"
            description="Instance vs activity, runtime modes, sandbox modes, theme, keymap, intents."
            href="/docs/core-concepts"
          />
        </Cards>
      </section>

      {/* ── Footer callout ───────────────────────────────────────────── */}
      <section>
        <Callout type="info" title="Reference apps">
          Every reference app under <code>apps/com.aura.*</code> in the repo is
          a working demonstration. Terminal (WS + PTY), Notepad (multi-activity
          shared state), Counter (multi × multi), Settings (content provider +
          theme), Console (WS persistence), Docs (raw runtime — this site).
        </Callout>
      </section>
    </main>
  );
}

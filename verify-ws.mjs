import { chromium } from 'playwright';

const URL = 'http://localhost:3002/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const logs = [];
page.on('console', m => logs.push(`[console:${m.type()}] ${m.text()}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('#ws-pills', { timeout: 15000 });
await sleep(800); // let workspaceClient hydrate + dispatcher load catalogue/state

// Helper: read pills as {n, active}
async function pills() {
  return page.$$eval('#ws-pills .ws-pill:not(.ws-pill-add):not(.ws-pill-nav)', els =>
    els.map(e => ({ n: e.textContent.trim(), active: e.getAttribute('data-active') === 'true', id: e.getAttribute('data-ws-id') })));
}

// Confirm the catalogue actually carries the new combos
const combos = await page.evaluate(async () => {
  const r = await fetch('/api/os/keymap'); const b = await r.json();
  const pick = id => (b.actions||[]).find(a => a.id === id);
  return {
    next: pick('aura.workspace.cycle-next')?.defaultCombo,
    prev: pick('aura.workspace.cycle-prev')?.defaultCombo,
  };
});
console.log('CATALOGUE combos:', JSON.stringify(combos));

// Ensure we have >=3 workspaces to make left/right meaningful. Create via Ctrl+Shift+N.
let p = await pills();
console.log('INITIAL pills:', JSON.stringify(p));
await page.locator('body').click({ position: { x: 700, y: 400 } }); // focus top document, away from iframes
for (let i = p.length; i < 3; i++) {
  await page.keyboard.press('Control+Shift+KeyN');
  await sleep(400);
}
p = await pills();
console.log('AFTER create pills:', JSON.stringify(p));

function activeN(arr){ const a = arr.find(x=>x.active); return a ? a.n : null; }

// Switch to workspace 1 as a known start
await page.keyboard.press('Control+Digit1');
await sleep(400);
p = await pills(); console.log('START (Ctrl+1) active =', activeN(p));
await page.screenshot({ path: '/tmp/ws-start.png' });

// RIGHT: next
await page.keyboard.press('Control+Shift+ArrowRight');
await sleep(400);
p = await pills(); const afterRight = activeN(p);
console.log('AFTER Ctrl+Shift+ArrowRight active =', afterRight);
await page.screenshot({ path: '/tmp/ws-right.png' });

// RIGHT again
await page.keyboard.press('Control+Shift+ArrowRight');
await sleep(400);
p = await pills(); const afterRight2 = activeN(p);
console.log('AFTER Ctrl+Shift+ArrowRight x2 active =', afterRight2);

// LEFT: prev
await page.keyboard.press('Control+Shift+ArrowLeft');
await sleep(400);
p = await pills(); const afterLeft = activeN(p);
console.log('AFTER Ctrl+Shift+ArrowLeft active =', afterLeft);
await page.screenshot({ path: '/tmp/ws-left.png' });

// PROBE 1: wrap-around — go left from workspace 1 should wrap to last
await page.keyboard.press('Control+Digit1'); await sleep(300);
await page.keyboard.press('Control+Shift+ArrowLeft'); await sleep(400);
p = await pills(); const wrapLeft = activeN(p);
console.log('PROBE wrap: Ctrl+1 then ArrowLeft active =', wrapLeft, '(total', p.length + ')');

// PROBE 2: old binding Ctrl+Tab should NO LONGER cycle workspaces
await page.keyboard.press('Control+Digit1'); await sleep(300);
const beforeTab = activeN(await pills());
await page.keyboard.press('Control+Tab'); await sleep(400);
const afterTab = activeN(await pills());
console.log('PROBE old Ctrl+Tab: before =', beforeTab, 'after =', afterTab, '(expect unchanged)');

console.log('--- relevant console logs ---');
console.log(logs.filter(l => /workspace|keymap|dispatch|error|warn/i.test(l)).slice(-15).join('\n') || '(none)');

await browser.close();

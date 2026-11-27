/**
 * A requester's multi-line text (D109 AF2: an agent's summary) with only
 * visible characters and plain newlines. Removed: C0 and C1 controls except
 * newline, the bidi controls (embeddings, overrides, isolates, marks),
 * zero-width spaces and the BOM, so nothing in it can reorder or hide what
 * the owner's dialog shows around it. No imports: the server (display.ts)
 * and the dialog in the browser (ownerDialog.ts) both run it.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export function visibleText(raw: string): string {
  return raw.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/\t/g, '  ').replace(INVISIBLE, '');
}

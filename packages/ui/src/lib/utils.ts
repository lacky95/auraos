import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Standard shadcn className combinator — clsx + tailwind-merge. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * JSON for an inline `<script type="application/json">` (Astro `set:html`).
 * `JSON.stringify` alone lets a string value close the element (`</script>`)
 * or open a comment (`<!--`); escaping every `<` (and the U+2028 / U+2029
 * line separators) keeps the data inert and still valid JSON for `JSON.parse`.
 */
export function escapeJsonForScript(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

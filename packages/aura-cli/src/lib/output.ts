/**
 * `-o` rendering for the kubectl-style verbs. Resources hand over RAW objects;
 * only this module decides how they look, so `-o json|yaml` always emit the
 * API data untouched while the table stays human-sized.
 */
import { stringify as toYaml } from 'yaml';
import { color, table } from './format.js';
import type { ResourceDef } from './resources.js';
import { shortName } from './resources.js';

export const OUTPUT_FORMATS = ['table', 'wide', 'json', 'yaml', 'name'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export function parseOutput(o: string | undefined): OutputFormat {
  const v = (o ?? 'table') as OutputFormat;
  if (!OUTPUT_FORMATS.includes(v)) {
    throw new Error(`unknown output format '${o}' (use one of: ${OUTPUT_FORMATS.filter((f) => f !== 'table').join(', ')})`);
  }
  return v;
}

export interface RenderOpts {
  output: OutputFormat;
  noHeaders?: boolean;
  /** A single named object was asked for — json/yaml emit it bare, not as a list. */
  single?: boolean;
}

/** Render objects of one resource kind; returns the text (no trailing newline). */
export function renderObjects(objs: unknown[], def: ResourceDef, opts: RenderOpts): string {
  switch (opts.output) {
    case 'json':
      return JSON.stringify(opts.single ? objs[0] : objs, null, 2);
    case 'yaml':
      return toYaml(opts.single ? objs[0] : objs).trimEnd();
    case 'name':
      return objs.map((o) => `${shortName(def)}/${def.nameOf(o)}`).join('\n');
    default: {
      if (objs.length === 0) return color.dim(`No ${def.name} found.`);
      const cols = def.columns.filter((c) => opts.output === 'wide' || !c.wide);
      const rows = objs.map((o) => Object.fromEntries(cols.map((c) => [c.header, c.value(o)])));
      const text = table(rows, cols.map((c) => c.header));
      return opts.noHeaders ? text.split('\n').slice(1).join('\n') : text;
    }
  }
}

/** Plain structured output for `describe` and other single-object views. */
export function renderDocument(doc: unknown, output: OutputFormat): string {
  if (output === 'json') return JSON.stringify(doc, null, 2);
  return toYaml(doc).trimEnd();
}

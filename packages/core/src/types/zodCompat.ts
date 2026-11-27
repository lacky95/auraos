/**
 * zod 3's validation messages and issue shapes on zod 4 (D62).
 *
 * AuraOS shows zod's messages to users and agents — manifest validation
 * (`aura dev validate`, install, clone), the D105 error bodies, notification
 * 400s — and returns the issues themselves in some bodies. zod 4 reworded
 * every default message ("Required" became "Invalid input: expected string,
 * received undefined"), reshaped the issues (`invalid_enum_value` is
 * `invalid_value`, `type` is `origin`, …) and keeps checking a value of the
 * wrong type (a `name` given as an array also fails `.min(1)` as an array).
 * Every boundary parse goes through `safeParse3`, which gives zod 3's result:
 * its default messages (a message the schema sets itself is unchanged), its
 * issue objects, and one issue per value of the wrong type.
 *
 * Per parse, not `z.config()`: zod 4 keeps that config on globalThis, shared
 * by every zod user in the process (the MCP SDK, fumadocs).
 * test/zod-golden.test.mjs holds it to what zod 3 gave.
 */
import type { z } from 'zod';
import type { $ZodErrorMap, $ZodIssue, $ZodRawIssue } from 'zod/v4/core';

type Values = readonly unknown[];

/** zod 3's name of a value's type ("received number"). */
function parsedType(v: unknown): string {
  switch (typeof v) {
    case 'number': return Number.isNaN(v) ? 'nan' : 'number';
    case 'object':
      if (Array.isArray(v)) return 'array';
      if (v === null) return 'null';
      if (typeof (v as { then?: unknown }).then === 'function' && typeof (v as { catch?: unknown }).catch === 'function') return 'promise';
      if (v instanceof Map) return 'map';
      if (v instanceof Set) return 'set';
      if (v instanceof Date) return 'date';
      return 'object';
    default: return typeof v;
  }
}

const joinValues = (values: Values, sep = ' | '): string => values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(sep);

/** The schema that raised a raw issue: 'enum', 'literal', … (finalized issues no longer say). */
const schemaType = (iss: { inst?: unknown }): string | undefined =>
  (iss.inst as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def?.type;

/** zod 3's validation kind of a zod 4 string-format issue. */
function validation(iss: Record<string, unknown>): string | Record<string, unknown> {
  switch (iss['format']) {
    case 'starts_with': return { startsWith: iss['prefix'] };
    case 'ends_with': return { endsWith: iss['suffix'] };
    case 'includes': return iss['position'] === undefined ? { includes: iss['includes'] } : { includes: iss['includes'], position: iss['position'] };
    case 'guid': return 'uuid';
    default: return String(iss['format']);
  }
}

/** zod 3's `type` of a size issue. */
const sizeType = (origin: unknown): string => (origin === 'int' ? 'number' : String(origin));

/**
 * The zod 3 issue an issue of zod 4 corresponds to, without its message.
 * `input` is the parsed value at the issue (raw issues carry it; finalized
 * ones only with `reportInput`).
 */
function zod3Fields(iss: Record<string, unknown>, input: unknown, hasInput: boolean, literal: boolean): { code: string } & Record<string, unknown> {
  switch (iss['code']) {
    case 'invalid_type': {
      const int = iss['expected'] === 'int';
      // zod 3 named a record "object".
      const expected = int ? 'integer' : iss['expected'] === 'record' ? 'object' : iss['expected'];
      return { code: 'invalid_type', expected, received: int ? 'float' : hasInput ? parsedType(input) : iss['received'] === 'NaN' ? 'nan' : 'undefined' };
    }
    case 'invalid_value': {
      const values = (iss['values'] ?? []) as Values;
      if (literal) return { code: 'invalid_literal', expected: values[0], received: input };
      // zod 3's enum refused a non-string with invalid_type ("Required" when absent).
      if (typeof input !== 'string') return { code: 'invalid_type', expected: joinValues(values), received: parsedType(input) };
      return { code: 'invalid_enum_value', options: [...values], received: input };
    }
    case 'invalid_format': return { code: 'invalid_string', validation: validation(iss) };
    case 'too_small': return { code: 'too_small', minimum: iss['minimum'], type: sizeType(iss['origin']), inclusive: iss['inclusive'] ?? true, exact: iss['exact'] === true };
    case 'too_big': return { code: 'too_big', maximum: iss['maximum'], type: sizeType(iss['origin']), inclusive: iss['inclusive'] ?? true, exact: iss['exact'] === true };
    case 'invalid_union':
      if (iss['note'] === 'No matching discriminator') return { code: 'invalid_union_discriminator', options: [...((iss['options'] ?? []) as Values)] };
      return { code: 'invalid_union' };
    case 'unrecognized_keys': return { code: 'unrecognized_keys', keys: iss['keys'] };
    case 'not_multiple_of': return { code: 'not_multiple_of', multipleOf: iss['divisor'] };
    case 'custom': return iss['params'] === undefined ? { code: 'custom' } : { code: 'custom', params: iss['params'] };
    default: return { code: String(iss['code']) };
  }
}

/** zod 3's default message for a zod 3 issue (its locales/en.ts). */
function zod3Message(i: Record<string, unknown>): string {
  const exact = i['exact'] === true;
  const inclusive = i['inclusive'] === true;
  switch (i['code']) {
    case 'invalid_type': return i['received'] === 'undefined' ? 'Required' : `Expected ${String(i['expected'])}, received ${String(i['received'])}`;
    case 'invalid_literal': return `Invalid literal value, expected ${JSON.stringify(i['expected'], (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`;
    case 'unrecognized_keys': return `Unrecognized key(s) in object: ${joinValues(i['keys'] as Values, ', ')}`;
    case 'invalid_union': return 'Invalid input';
    case 'invalid_union_discriminator': return `Invalid discriminator value. Expected ${joinValues(i['options'] as Values)}`;
    case 'invalid_enum_value': return `Invalid enum value. Expected ${joinValues(i['options'] as Values)}, received '${String(i['received'])}'`;
    case 'invalid_string': {
      const v = i['validation'];
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if ('includes' in o) return `Invalid input: must include "${String(o['includes'])}"${typeof o['position'] === 'number' ? ` at one or more positions greater than or equal to ${o['position']}` : ''}`;
        if ('startsWith' in o) return `Invalid input: must start with "${String(o['startsWith'])}"`;
        return `Invalid input: must end with "${String(o['endsWith'])}"`;
      }
      return v === 'regex' ? 'Invalid' : `Invalid ${String(v)}`;
    }
    case 'too_small': {
      const min = i['minimum'];
      switch (i['type']) {
        case 'array': return `Array must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${String(min)} element(s)`;
        case 'string': return `String must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'over'} ${String(min)} character(s)`;
        case 'number': case 'bigint': return `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${String(min)}`;
        case 'date': return `Date must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${new Date(Number(min))}`;
        default: return 'Invalid input';
      }
    }
    case 'too_big': {
      const max = i['maximum'];
      switch (i['type']) {
        case 'array': return `Array must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${String(max)} element(s)`;
        case 'string': return `String must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'under'} ${String(max)} character(s)`;
        case 'number': return `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${String(max)}`;
        case 'bigint': return `BigInt must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${String(max)}`;
        case 'date': return `Date must be ${exact ? 'exactly' : inclusive ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(max))}`;
        default: return 'Invalid input';
      }
    }
    case 'not_multiple_of': return `Number must be a multiple of ${String(i['multipleOf'])}`;
    default: return 'Invalid input';
  }
}

/** zod 4 error map giving zod 3's default messages. */
export const zod3ErrorMap: $ZodErrorMap = (iss: $ZodRawIssue) => {
  // A record key: zod 4 nests the key's own issues; their messages are already set.
  if (iss.code === 'invalid_key') return undefined;
  return zod3Message(zod3Fields(iss as unknown as Record<string, unknown>, iss.input, true, schemaType(iss) === 'literal'));
};

/** Parse params for zod 3's messages only (a parse whose issues nobody reads): `Schema.parse(input, ZOD3)`. */
export const ZOD3 = { error: zod3ErrorMap } as const;

/** One issue as zod 3 reported it. */
export interface Zod3Issue {
  code: string;
  path: (string | number)[];
  message: string;
  [field: string]: unknown;
}

/**
 * The issues of a failed parse as zod 3 gave them (`unionErrors` left out).
 * The issues must carry their input (`reportInput`): zod 3 named the
 * received type. zod 3 stopped at a value of the wrong type; zod 4 still runs
 * its length checks, so a later issue at the same path is dropped.
 */
function zodIssues(issues: readonly $ZodIssue[]): Zod3Issue[] {
  const out: Zod3Issue[] = [];
  const wrongType = new Set<string>();
  const add = (iss: $ZodIssue, prefix: PropertyKey[]): void => {
    const raw = iss as unknown as Record<string, unknown>;
    const path = [...prefix, ...iss.path].map((p) => (typeof p === 'symbol' ? String(p) : p)) as (string | number)[];
    if (iss.code === 'invalid_key') {
      // zod 3 reported a bad record key at the key, with the key's own issue.
      for (const inner of (raw['issues'] ?? []) as $ZodIssue[]) add(inner, path);
      return;
    }
    const at = JSON.stringify(path);
    if (wrongType.has(at)) return;
    if (iss.code === 'invalid_type') wrongType.add(at);
    // A literal's issue is told from an enum's by the message the map gave it.
    const literal = iss.message.startsWith('Invalid literal value');
    out.push({ ...zod3Fields(raw, raw['input'], 'input' in raw, literal), path, message: iss.message });
  };
  for (const iss of issues) add(iss, []);
  return out;
}

export type Zod3Result<T> = { success: true; data: T } | { success: false; issues: Zod3Issue[] };

/**
 * `schema.safeParse(input)` with zod 3's messages and issues: the parse every
 * boundary (manifests, API bodies, the patch series) uses.
 */
export function safeParse3<S extends z.ZodType>(schema: S, input: unknown): Zod3Result<z.output<S>> {
  const r = schema.safeParse(input, { ...ZOD3, reportInput: true });
  return r.success ? { success: true, data: r.data } : { success: false, issues: zodIssues(r.error.issues) };
}

/** `path: message; …` of zod 3 issues; `root` names the empty path. */
export function formatIssues(issues: readonly Zod3Issue[], root = ''): string {
  return issues.map((i) => `${i.path.join('.') || root}: ${i.message}`).join('; ');
}

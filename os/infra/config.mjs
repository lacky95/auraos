// AuraOS infrastructure configuration (D94, IC-1): the one schema, parser and
// validator. Dependency-free on purpose: install.sh runs it on the host (or in
// a throwaway node container) before anything is downloaded or built, and the
// kernel, the release builder and the CLI read the same file with it (D36:
// one validator). The file is YAML (O1); this module reads the subset the
// schema needs (block and flow mappings and sequences, quoted and plain
// scalars, comments) and refuses the rest (anchors, aliases, tags, block
// scalars, several documents) with a clear error. JSON is accepted too.
//
// Rules (D94 §4.2, §7): no secret values anywhere (credentials only as refs
// `bootstrap:<name>` / `system:<NAME>`), no TLS-weakening field exists, no
// userinfo in URLs, unknown fields are refused, `http://` registries are
// allowed but reported as unencrypted (D91).
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const INFRA_CONFIG_VERSION = 1;

export class InfraConfigError extends Error {
  constructor(errors) {
    super(errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('\n'));
    this.code = 'invalid-config';
    this.errors = errors;
  }
}

// ── YAML subset ─────────────────────────────────────────────────────────────

class YamlError extends Error {
  constructor(line, message) { super(`line ${line}: ${message}`); this.code = 'yaml'; this.line = line; }
}

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === '\\') { i++; continue; }
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function prepare(text) {
  const out = [];
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((raw, idx) => {
    const no = idx + 1;
    const lead = /^[ \t]*/.exec(raw)[0];
    if (lead.includes('\t') && raw.trim()) throw new YamlError(no, 'tabs are not allowed for indentation');
    const body = stripComment(raw).trimEnd();
    if (!body.trim()) return;
    const t = body.trim();
    if (t === '---' && !out.length) return;
    if (t === '---' || t === '...') throw new YamlError(no, 'only one YAML document is supported');
    out.push({ no, indent: lead.length, text: t });
  });
  return out;
}

const unsupported = (no, t) => {
  if (/^[&*!]/.test(t)) throw new YamlError(no, 'anchors, aliases and tags are not supported');
  if (/^[@`%]/.test(t)) throw new YamlError(no, `a plain value cannot start with ${t[0]}: quote it`);
  if (/^[|>][+-]?\d*$/.test(t)) throw new YamlError(no, 'block scalars (| and >) are not supported; use a quoted string');
};

function plainScalar(s) {
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?(0|[1-9]\d*)$/.test(s)) return Number(s);
  return s;
}

/** A quoted scalar at s[i]; returns [value, nextIndex]. */
function quoted(s, i, no) {
  const q = s[i];
  if (q === "'") {
    let out = '';
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === "'") { if (s[j + 1] === "'") { out += "'"; j++; continue; } return [out, j + 1]; }
      out += s[j];
    }
    throw new YamlError(no, 'unterminated single-quoted string');
  }
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '"') {
      try { return [JSON.parse(s.slice(i, j + 1)), j + 1]; } catch { throw new YamlError(no, 'bad escape in a double-quoted string'); }
    }
  }
  throw new YamlError(no, 'unterminated double-quoted string');
}

/** A flow value (`{…}`, `[…]`, quoted or plain until , ] }) starting at s[i]. */
function flow(s, i, no) {
  const ws = () => { while (i < s.length && s[i] === ' ') i++; };
  ws();
  const c = s[i];
  if (c === '{' || c === '[') {
    const close = c === '{' ? '}' : ']';
    const out = c === '{' ? {} : [];
    i++;
    for (;;) {
      ws();
      if (s[i] === close) return [out, i + 1];
      if (i >= s.length) throw new YamlError(no, `missing ${close}`);
      if (c === '{') {
        let key;
        if (s[i] === '"' || s[i] === "'") [key, i] = quoted(s, i, no);
        else {
          const m = /^([^:,{}[\]]+?):(?=\s|$|[,}])/.exec(s.slice(i));
          if (!m) throw new YamlError(no, 'expected "key: value" in a flow mapping');
          key = m[1].trim();
          i += m[1].length;
        }
        ws();
        if (s[i] !== ':') throw new YamlError(no, `expected ":" after ${JSON.stringify(key)}`);
        i++;
        let v;
        [v, i] = flow(s, i, no);
        if (Object.hasOwn(out, key)) throw new YamlError(no, `duplicate key ${JSON.stringify(key)}`);
        out[key] = v;
      } else {
        let v;
        [v, i] = flow(s, i, no);
        out.push(v);
      }
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] !== close) throw new YamlError(no, `expected "," or "${close}"`);
    }
  }
  if (c === '"' || c === "'") return quoted(s, i, no);
  unsupported(no, s.slice(i));
  const m = /^[^,{}[\]]*/.exec(s.slice(i));
  return [plainScalar(m[0].trim()), i + m[0].length];
}

const balanced = (s) => {
  let depth = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (q === '"' && c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return depth <= 0;
};

/** `key: rest` at the start of a block line, or null. */
function splitKey(t, no) {
  if (t[0] === '"' || t[0] === "'") {
    const [key, j] = quoted(t, 0, no);
    const rest = t.slice(j);
    if (!/^\s*:(\s|$)/.test(rest)) return null;
    return { key, rest: rest.replace(/^\s*:/, '').trim() };
  }
  if (t[0] === '{' || t[0] === '[') return null;
  const m = /^([^:#]+?):(\s+|$)/.exec(t);
  return m ? { key: m[1].trim(), rest: t.slice(m[0].length).trim() } : null;
}

const isSeqItem = (t) => t === '-' || t.startsWith('- ');

export function parseYaml(text) {
  const L = prepare(text);
  let i = 0;
  const value = (rest, line) => {
    unsupported(line.no, rest);
    if (rest[0] === '{' || rest[0] === '[') {
      let s = rest;
      while (!balanced(s) && i < L.length) s += ` ${L[i++].text}`;
      const [v, end] = flow(s, 0, line.no);
      if (s.slice(end).trim()) throw new YamlError(line.no, 'unexpected text after a flow collection');
      return v;
    }
    if (rest[0] === '"' || rest[0] === "'") {
      const [v, end] = quoted(rest, 0, line.no);
      if (rest.slice(end).trim()) throw new YamlError(line.no, 'unexpected text after a quoted string');
      return v;
    }
    return plainScalar(rest);
  };
  const block = (indent) => (isSeqItem(L[i].text) ? seq(indent) : map(indent));
  const nested = (indent, line) => {
    if (i < L.length && L[i].indent > indent) {
      // A flow collection (or a scalar) on the lines below its key.
      if (!isSeqItem(L[i].text) && !splitKey(L[i].text, L[i].no)) { const l = L[i++]; return value(l.text, l); }
      return block(L[i].indent);
    }
    return null;
  };
  function map(indent) {
    const out = {};
    while (i < L.length && L[i].indent === indent && !isSeqItem(L[i].text)) {
      const line = L[i++];
      const kv = splitKey(line.text, line.no);
      if (!kv) throw new YamlError(line.no, 'expected "key: value"');
      if (Object.hasOwn(out, kv.key)) throw new YamlError(line.no, `duplicate key ${JSON.stringify(kv.key)}`);
      if (kv.rest) out[kv.key] = value(kv.rest, line);
      else if (i < L.length && L[i].indent === indent && isSeqItem(L[i].text)) out[kv.key] = seq(indent);
      else out[kv.key] = nested(indent, line);
    }
    if (i < L.length && L[i].indent > indent) throw new YamlError(L[i].no, 'bad indentation');
    return out;
  }
  function seq(indent) {
    const out = [];
    while (i < L.length && L[i].indent === indent && isSeqItem(L[i].text)) {
      const line = L[i];
      const content = line.text === '-' ? '' : line.text.slice(2).trimStart();
      if (!content) { i++; out.push(nested(indent, line)); continue; }
      if (splitKey(content, line.no)) {
        // "- key: v" starts a mapping whose keys sit at the content column.
        L[i] = { no: line.no, indent: indent + (line.text.length - content.length), text: content };
        out.push(map(L[i].indent));
      } else { i++; out.push(value(content, line)); }
    }
    if (i < L.length && L[i].indent > indent) throw new YamlError(L[i].no, 'bad indentation');
    return out;
  }
  if (!L.length) return null;
  if (L[0].indent !== 0) throw new YamlError(L[0].no, 'the document must start at column 1');
  const doc = (L[0].text[0] === '{' || L[0].text[0] === '[') ? value((i++, L[0].text), L[0]) : block(0);
  if (i < L.length) throw new YamlError(L[i].no, 'unexpected content');
  return doc;
}

/** Block YAML for plain data (the stored config, the compose override). */
export function toYaml(v, indent = 0) {
  const pad = ' '.repeat(indent);
  const scalar = (x) => {
    if (x === null || x === undefined) return 'null';
    if (typeof x === 'boolean' || typeof x === 'number') return String(x);
    if (x instanceof YamlTag) return `${x.tag} ${x.value === undefined ? '' : flowYaml(x.value)}`.trimEnd();
    return /^[A-Za-z0-9_./][A-Za-z0-9_./@+-]*$/.test(x) && !/^(true|false|null|~|-?\d+)$/.test(x) ? x : JSON.stringify(x);
  };
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}[]\n`;
    return v.map((x) => (x && typeof x === 'object' && !(x instanceof YamlTag)
      ? `${pad}- ${toYaml(x, indent + 2).trimStart()}` : `${pad}- ${scalar(x)}\n`)).join('');
  }
  if (v && typeof v === 'object' && !(v instanceof YamlTag)) {
    const keys = Object.keys(v);
    if (!keys.length) return `${pad}{}\n`;
    return keys.map((k) => {
      const x = v[k];
      const key = scalar(k);
      if (x && typeof x === 'object' && !(x instanceof YamlTag) && (Array.isArray(x) ? x.length : Object.keys(x).length)) {
        return `${pad}${key}:\n${toYaml(x, indent + 2)}`;
      }
      return `${pad}${key}: ${Array.isArray(x) ? '[]' : (x && typeof x === 'object' && !(x instanceof YamlTag)) ? '{}' : scalar(x)}\n`;
    }).join('');
  }
  return `${pad}${scalar(v)}\n`;
}
const flowYaml = (v) => JSON.stringify(v);

/** A tagged value for toYaml (compose's `!reset` / `!override`). */
export class YamlTag { constructor(tag, value) { this.tag = tag; this.value = value; } }

// ── schema ──────────────────────────────────────────────────────────────────

const REF = /^(bootstrap|system):([A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
/** Field names that would weaken TLS or carry a secret: never part of the schema. */
const TLS_WEAKENING = /^(insecure|strict-?ssl|strictSsl|ssl-?verify|sslVerify|verify-?ssl|tls-?verify|trusted-?host|trustedHost|allow-?unauthenticated|allowUnauthenticated|allow-?insecure.*|reject-?unauthorized|rejectUnauthorized|skip-?verify|skipVerify|no-?verify)$/i;
const SECRETISH = /^(password|passwd|pass|token|_?authToken|auth|_auth|secret|apiKey|api-key|privateKey|private-key|bearer)$/i;
const BETA_REGISTRIES = new Set(['maven', 'gradle', 'go', 'cargo', 'yarnBerry']);
/** AuraOS-internal destinations that never go through a corporate proxy (D94 §5.4). */
export const INTERNAL_NO_PROXY = Object.freeze(['localhost', '127.0.0.1', '::1', '.localhost', 'aura-shell', 'aura-net', '.aura-net']);

/**
 * Validates a parsed config. Returns `{ ok, config, errors: [{path, message}],
 * warnings: [{path, message}] }`; `config` is the input with defaults filled
 * in (no config section means today's behaviour for it).
 */
export function validateInfraConfig(input) {
  const errors = [], warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  // Forbidden names anywhere first: they get a specific reason, not "unknown field".
  const scan = (v, path) => {
    if (typeof v === 'string' && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v)) err(path, 'a private key in the config: reference it with key: { ref: "bootstrap:<name>" } instead');
    if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${path}[${i}]`));
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      if (TLS_WEAKENING.test(k)) err(p, 'TLS verification can never be turned off (D94 §7.5): add the CA under trust.caCertificates instead');
      else if (SECRETISH.test(k)) err(p, 'secrets never go into the config: use credential: { ref: "bootstrap:<name>" } and a file in --credentials-dir');
      scan(x, p);
    }
  };
  scan(input, '');
  if (!isObj(input)) { err('', 'the config must be a mapping'); return { ok: false, config: null, errors, warnings }; }

  const only = (obj, path, allowed) => {
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k) && !TLS_WEAKENING.test(k) && !SECRETISH.test(k)) err(path ? `${path}.${k}` : k, `unknown field (allowed: ${allowed.join(', ')})`);
    }
  };
  const ref = (v, path) => {
    if (!isObj(v) || Object.keys(v).length !== 1 || typeof v.ref !== 'string') { err(path, 'expected { ref: "bootstrap:<name>" }'); return null; }
    if (/^user:/.test(v.ref)) { err(`${path}.ref`, 'user: refs belong to a user\'s vault, not to the system config'); return null; }
    if (!REF.test(v.ref)) { err(`${path}.ref`, 'expected bootstrap:<name> or system:<NAME> (letters, digits, _ . -)'); return null; }
    return v.ref;
  };
  const url = (v, path, { schemes = ['https:', 'http:'] } = {}) => {
    if (typeof v !== 'string') { err(path, 'expected a URL'); return; }
    let u;
    try { u = new URL(v); } catch { err(path, 'not a URL'); return; }
    if (!schemes.includes(u.protocol)) { err(path, `the scheme must be ${schemes.map((s) => s.slice(0, -1)).join(' or ')}`); return; }
    if (u.username || u.password) { err(path, 'no user:password in URLs: use a credential ref'); return; }
    if (/[?&][^=&]*(?:token|auth|key|pass|secret)[^=&]*=/i.test(u.search)) err(path, 'no credentials in the query string: use a credential ref');
    if (u.protocol === 'http:' && !path.includes('proxy')) warn(path, 'unencrypted http:// endpoint (allowed; reported, D91)');
  };
  const hostPath = (v, path) => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._/-]*)?$/.test(v) || !HOST.test(v.split(/[:/]/)[0])) err(path, 'expected a registry host[:port][/path] without scheme');
  };
  const map = (v, path, check) => {
    if (!isObj(v)) { err(path, 'expected a mapping'); return; }
    for (const [k, x] of Object.entries(v)) check(k, x, `${path}["${k}"]`);
  };
  const list = (v, path, check) => {
    if (!Array.isArray(v)) { err(path, 'expected a list'); return; }
    v.forEach((x, i) => check(x, `${path}[${i}]`));
  };

  only(input, '', ['version', 'network', 'trust', 'clientCertificates', 'registries', 'policy']);
  if (input.version !== INFRA_CONFIG_VERSION) err('version', `must be ${INFRA_CONFIG_VERSION}`);

  const cfg = structuredClone(input);
  if (cfg.network !== undefined) {
    const n = cfg.network;
    if (!isObj(n)) err('network', 'expected a mapping');
    else {
      only(n, 'network', ['proxy', 'dns']);
      if (n.proxy !== undefined) {
        const p = n.proxy;
        if (!isObj(p)) err('network.proxy', 'expected a mapping');
        else {
          only(p, 'network.proxy', ['http', 'https', 'noProxy', 'credential']);
          if (p.http === undefined && p.https === undefined) err('network.proxy', 'set http and/or https');
          if (p.http !== undefined) url(p.http, 'network.proxy.http');
          if (p.https !== undefined) url(p.https, 'network.proxy.https');
          if (p.noProxy !== undefined) list(p.noProxy, 'network.proxy.noProxy', (x, path) => {
            if (typeof x !== 'string' || !/^[A-Za-z0-9.:_/*-]+$/.test(x) || x === '*') err(path, 'expected a host, .domain, IP or CIDR ("*" would bypass the proxy for everything)');
          });
          if (p.credential !== undefined) ref(p.credential, 'network.proxy.credential');
        }
      }
      if (n.dns !== undefined) {
        const d = n.dns;
        const ips = (v, path) => list(v, path, (x, pp) => { if (typeof x !== 'string' || !isIP(x)) err(pp, 'expected an IP address'); });
        if (d === 'host' || d === 'default') { /* host resolver | today's compose default */ } else if (Array.isArray(d)) {
          ips(d, 'network.dns');
          if (!d.length) err('network.dns', 'an empty list: use dns: host');
        } else if (isObj(d)) {
          only(d, 'network.dns', ['servers', 'search']);
          if (d.servers !== undefined) ips(d.servers, 'network.dns.servers');
          if (d.search !== undefined) list(d.search, 'network.dns.search', (x, pp) => { if (typeof x !== 'string' || !HOST.test(x)) err(pp, 'expected a domain'); });
        } else err('network.dns', 'expected host, default, a list of IPs, or { servers, search }');
      }
    }
  }
  if (cfg.trust !== undefined) {
    const t = cfg.trust;
    if (!isObj(t)) err('trust', 'expected a mapping');
    else {
      only(t, 'trust', ['caCertificates', 'publicRoots']);
      const names = new Set();
      if (t.caCertificates !== undefined) list(t.caCertificates, 'trust.caCertificates', (x, path) => {
        if (!isObj(x)) { err(path, 'expected { name, file }'); return; }
        only(x, path, ['name', 'file']);
        if (typeof x.name !== 'string' || !NAME.test(x.name)) err(`${path}.name`, 'expected a lowercase name (a-z, 0-9, -)');
        else if (names.has(x.name)) err(`${path}.name`, 'duplicate name'); else names.add(x.name);
        if (typeof x.file !== 'string' || !x.file) err(`${path}.file`, 'expected a file path');
      });
      if (t.publicRoots !== undefined && !['keep', 'replace'].includes(t.publicRoots)) err('trust.publicRoots', 'keep or replace');
      if (t.publicRoots === 'replace') warn('trust.publicRoots', 'replace: only the corporate CAs are trusted (needs infra-public-roots=replace, an explicit owner choice)');
    }
  }
  if (cfg.clientCertificates !== undefined) {
    const names = new Set();
    list(cfg.clientCertificates, 'clientCertificates', (x, path) => {
      if (!isObj(x)) { err(path, 'expected a mapping'); return; }
      only(x, path, ['name', 'hosts', 'certificate', 'key', 'identity']);
      if (typeof x.name !== 'string' || !NAME.test(x.name)) err(`${path}.name`, 'expected a lowercase name (a-z, 0-9, -)');
      else if (names.has(x.name)) err(`${path}.name`, 'duplicate name'); else names.add(x.name);
      list(x.hosts, `${path}.hosts`, (h, pp) => { if (typeof h !== 'string' || !HOST.test(h)) err(pp, 'expected a host name'); });
      if (Array.isArray(x.hosts) && !x.hosts.length) err(`${path}.hosts`, 'name at least one host');
      if (!isObj(x.certificate) || typeof x.certificate.file !== 'string' || Object.keys(x.certificate).length !== 1) err(`${path}.certificate`, 'expected { file: <public certificate PEM> }');
      ref(x.key, `${path}.key`);
      if (x.identity !== undefined && x.identity !== 'system') err(`${path}.identity`, 'only system in this version (app and user identities: beta, BT-I)');
    });
  }
  if (cfg.registries !== undefined) {
    const r = cfg.registries;
    if (!isObj(r)) err('registries', 'expected a mapping');
    else {
      for (const k of Object.keys(r)) if (BETA_REGISTRIES.has(k)) err(`registries.${k}`, 'not supported in this version (beta, BT-I)');
      only(r, 'registries', ['npm', 'python', 'apt', 'oci', 'git', 'artifacts', ...BETA_REGISTRIES]);
      const sect = (name, allowed, fn) => {
        if (r[name] === undefined) return;
        if (!isObj(r[name])) { err(`registries.${name}`, 'expected a mapping'); return; }
        only(r[name], `registries.${name}`, allowed);
        fn(r[name], `registries.${name}`);
        if (r[name].credential !== undefined) ref(r[name].credential, `registries.${name}.credential`);
      };
      sect('npm', ['url', 'scopes', 'credential'], (s, p) => {
        if (s.url === undefined) err(`${p}.url`, 'required'); else url(s.url, `${p}.url`);
        if (s.scopes !== undefined) map(s.scopes, `${p}.scopes`, (k, v, pp) => { if (!/^@[a-z0-9][a-z0-9._-]*$/.test(k)) err(pp, 'expected an npm scope (@name)'); url(v, pp); });
      });
      sect('python', ['index', 'credential'], (s, p) => { if (s.index === undefined) err(`${p}.index`, 'required'); else url(s.index, `${p}.index`); });
      sect('apt', ['mirrors', 'credential'], (s, p) => {
        if (s.mirrors === undefined) err(`${p}.mirrors`, 'required');
        else map(s.mirrors, `${p}.mirrors`, (k, v, pp) => { if (!HOST.test(k)) err(pp, 'expected the upstream host (deb.debian.org)'); url(v, pp); });
      });
      sect('oci', ['mirrors', 'credentials'], (s, p) => {
        if (s.mirrors !== undefined) map(s.mirrors, `${p}.mirrors`, (k, v, pp) => { if (!HOST.test(k)) err(pp, 'expected the upstream registry (docker.io)'); hostPath(v, pp); });
        if (s.credentials !== undefined) map(s.credentials, `${p}.credentials`, (k, v, pp) => { if (!HOST.test(k.split(':')[0])) err(pp, 'expected a registry host'); ref(v, pp); });
      });
      sect('git', ['rewrites', 'credential'], (s, p) => {
        if (s.rewrites !== undefined) map(s.rewrites, `${p}.rewrites`, (k, v, pp) => { url(k, `${pp} (key)`); url(v, pp); });
      });
      sect('artifacts', ['rewrites'], (s, p) => {
        if (s.rewrites !== undefined) map(s.rewrites, `${p}.rewrites`, (k, v, pp) => { url(k, `${pp} (key)`); url(v, pp); });
      });
    }
  }
  if (cfg.policy !== undefined) {
    const p = cfg.policy;
    if (!isObj(p)) err('policy', 'expected a mapping');
    else {
      only(p, 'policy', ['publicFallback', 'proxy']);
      if (p.publicFallback !== undefined && !['allow', 'deny'].includes(p.publicFallback)) err('policy.publicFallback', 'allow or deny');
      if (p.proxy !== undefined && !['off', 'configured'].includes(p.proxy)) err('policy.proxy', 'off or configured (enforced: beta)');
    }
  }
  return { ok: errors.length === 0, config: errors.length ? null : cfg, errors, warnings };
}

/** Parse + validate; throws InfraConfigError (with every error) when invalid. */
export function parseInfraConfig(text) {
  let doc;
  try { doc = parseYaml(text); } catch (e) {
    if (e.code === 'yaml') throw new InfraConfigError([{ path: '', message: `YAML ${e.message}` }]);
    throw e;
  }
  const r = validateInfraConfig(doc);
  if (!r.ok) throw new InfraConfigError(r.errors);
  return r;
}

// ── what the config refers to ───────────────────────────────────────────────

/** Every credential ref with where it is used and the hosts it may reach (host binding, D94 §7.4). */
export function refsOf(cfg) {
  const out = [];
  const add = (ref, path, hosts) => { if (ref) out.push({ ref, path, hosts: [...new Set(hosts)].sort() }); };
  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return String(u).split(/[:/]/)[0]; } };
  const p = cfg.network?.proxy;
  if (p?.credential) add(p.credential.ref, 'network.proxy.credential', [p.http, p.https].filter(Boolean).map(hostOf));
  for (const c of cfg.clientCertificates ?? []) add(c.key.ref, `clientCertificates.${c.name}.key`, c.hosts);
  const r = cfg.registries ?? {};
  if (r.npm?.credential) add(r.npm.credential.ref, 'registries.npm.credential', [r.npm.url, ...Object.values(r.npm.scopes ?? {})].map(hostOf));
  if (r.python?.credential) add(r.python.credential.ref, 'registries.python.credential', [hostOf(r.python.index)]);
  if (r.apt?.credential) add(r.apt.credential.ref, 'registries.apt.credential', Object.values(r.apt.mirrors ?? {}).map(hostOf));
  for (const [h, v] of Object.entries(r.oci?.credentials ?? {})) add(v.ref, `registries.oci.credentials.${h}`, [h.split(':')[0]]);
  if (r.git?.credential) add(r.git.credential.ref, 'registries.git.credential', Object.values(r.git.rewrites ?? {}).map(hostOf));
  return out;
}

/** The endpoints a preflight checks: `{ kind, url }` (URLs) and `{ kind, host }`. */
export function endpointsOf(cfg) {
  const out = [];
  const p = cfg.network?.proxy;
  if (p?.http) out.push({ kind: 'proxy', url: p.http });
  if (p?.https && p.https !== p.http) out.push({ kind: 'proxy', url: p.https });
  const r = cfg.registries ?? {};
  if (r.npm) { out.push({ kind: 'npm', url: r.npm.url }); for (const u of Object.values(r.npm.scopes ?? {})) out.push({ kind: 'npm', url: u }); }
  if (r.python) out.push({ kind: 'python', url: r.python.index });
  for (const u of Object.values(r.apt?.mirrors ?? {})) out.push({ kind: 'apt', url: u });
  for (const m of Object.values(r.oci?.mirrors ?? {})) out.push({ kind: 'oci', url: `https://${m.split('/')[0]}/v2/` });
  for (const u of Object.values(r.git?.rewrites ?? {})) out.push({ kind: 'git', url: u });
  for (const u of Object.values(r.artifacts?.rewrites ?? {})) out.push({ kind: 'artifacts', url: u });
  const seen = new Set();
  return out.filter((e) => !seen.has(`${e.kind} ${e.url}`) && seen.add(`${e.kind} ${e.url}`));
}

/** Client certificate (mTLS) assignment for a URL, or null. */
export function clientCertFor(cfg, url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  return (cfg.clientCertificates ?? []).find((c) => c.hosts.includes(host)) ?? null;
}

/** NO_PROXY: the configured entries plus AuraOS-internal names, de-duplicated (D94 §5.4). */
export function computeNoProxy(cfg, extra = []) {
  return [...new Set([...(cfg.network?.proxy?.noProxy ?? []), ...INTERNAL_NO_PROXY, ...extra])].join(',');
}

/** A URL rewritten by the first matching prefix of a rewrites map. */
export function rewriteUrl(url, rewrites = {}) {
  const hit = Object.keys(rewrites).sort((a, b) => b.length - a.length).find((p) => url.startsWith(p));
  return hit ? rewrites[hit] + url.slice(hit.length) : url;
}

/** An image reference through `registries.oci.mirrors` (docker.io/library implied). */
export function rewriteImage(ref, mirrors = {}) {
  const first = ref.split('/')[0];
  const explicit = ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  const registry = explicit ? first : 'docker.io';
  let path = explicit ? ref.slice(first.length + 1) : ref;
  if (registry === 'docker.io' && !path.includes('/')) path = `library/${path}`;
  const m = mirrors[registry];
  return m ? `${m.replace(/\/$/, '')}/${path}` : ref;
}

/** Stable JSON (sorted keys) for digests. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** The digest of a config and the public material it imports (CA and client certificate PEMs). */
export function configDigest(cfg, files = {}) {
  const h = createHash('sha256').update(canonicalJson(cfg));
  for (const k of Object.keys(files).sort()) h.update(`\0${k}\0`).update(files[k]);
  return `sha256:${h.digest('hex')}`;
}

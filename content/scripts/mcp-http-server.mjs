#!/usr/bin/env node
/**
 * mcp-http-server.mjs — rasa.module.http v0.1.0
 *
 * Portable MCP server giving agents generic HTTP/REST access with
 * self-policed guardrails. Node >= 18, ESM, ZERO dependencies
 * (built-in fetch + readline only). Single file by design so it can be
 * pointed at from any project's .mcp.json without an install step.
 *
 * HONESTY TIER — read this before trusting it:
 *   Every control in this file (allowlist, private-host block, secret
 *   redaction, byte caps) is enforced INSIDE this process. A tool that
 *   bypasses this server bypasses the policy. The enforced tier is the
 *   kernel-side HttpExecutor (canon SA-031: kernel choke point, enforced
 *   allowlist, call-time secret resolution). Once SA-031 lands, this
 *   module is dev-tenant/utility only.
 *
 * HARD RULES implemented here:
 *   - Deny by default: HTTP_ALLOWED_HOSTS unset/empty => ALL egress
 *     denied with a helpful error.
 *   - Secrets: NAMES in config, VALUES only in env. Values injected from
 *     HTTP_AUTH_* are scrubbed from every error message and audit line
 *     this server composes. (Upstream response bodies are returned as-is
 *     — they are data; if an upstream echoes your header back, that is
 *     the upstream's doing, not a leak from this process.)
 *   - Private/loopback/link-local hosts are ALWAYS denied unless the
 *     exact host is explicitly allowlisted — "*" and "*.suffix" never
 *     cover them. HONEST LIMIT: the check is on the hostname LITERAL
 *     only. There is NO DNS pinning at this tier — a public DNS name
 *     that resolves to 10.0.0.5 will get through. DNS-rebinding defense
 *     is a kernel-tier (SA-031) property, not a self-policing one.
 *   - STDOUT carries ONLY JSON-RPC. All logging + audit go to stderr.
 *
 * Env config:
 *   HTTP_ALLOWED_HOSTS       comma list; "*.suffix" wildcards; "*" = all
 *                            PUBLIC hosts. Unset/empty = deny everything.
 *   HTTP_AUTH_<HOST>         full header line ("Authorization: Bearer x")
 *                            injected for that host when the caller did
 *                            not set the header. HOST is sanitized:
 *                            api.github.com -> HTTP_AUTH_API_GITHUB_COM.
 *   HTTP_TIMEOUT_MS          default 30000
 *   HTTP_MAX_RESPONSE_BYTES  default 262144
 *   HTTP_CONNECTIONS_DIR     default .claude/connections
 */

import { createInterface } from "node:readline";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const VERSION = "0.1.0";
const MAX_REDIRECTS = 5;
const MAX_PAGES = 10;

// ---------------------------------------------------------------------------
// Config (read once at startup; the process is cheap to restart on change)
// ---------------------------------------------------------------------------

function intEnv(name, fallback) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const cfg = {
  allowlist: (process.env.HTTP_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  timeoutMs: intEnv("HTTP_TIMEOUT_MS", 30000),
  maxBytes: intEnv("HTTP_MAX_RESPONSE_BYTES", 262144),
  connectionsDir: process.env.HTTP_CONNECTIONS_DIR || ".claude/connections",
};

// ---------------------------------------------------------------------------
// Secret redaction. We register every HTTP_AUTH_* VALUE (and its trailing
// token, e.g. the raw bearer token inside "Bearer xyz") at startup, and
// scrub them from every string this server composes outbound: error
// messages, fix_hints, notes, audit lines. Constraint: redaction is
// best-effort string replacement — it protects against the common leak
// paths (error echoes, logs), not against an adversarial upstream.
// ---------------------------------------------------------------------------

const SECRET_VALUES = [];
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("HTTP_AUTH_") || !v) continue;
  const i = v.indexOf(":");
  const val = (i >= 0 ? v.slice(i + 1) : v).trim();
  if (val.length >= 4) {
    SECRET_VALUES.push(val);
    const last = val.split(/\s+/).pop();
    if (last && last !== val && last.length >= 4) SECRET_VALUES.push(last);
  }
}

function scrub(s) {
  let out = String(s);
  for (const sec of SECRET_VALUES) out = out.split(sec).join("<redacted>");
  return out;
}

// ---------------------------------------------------------------------------
// Allowlist + private-host policy
// ---------------------------------------------------------------------------

/** Hostname-LITERAL private/loopback/link-local check. No DNS resolution. */
function isPrivateHost(hostRaw) {
  let host = hostRaw.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/); // v4-mapped v6
  if (mapped) host = mapped[1];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const o = host.split(".").map(Number);
    if (o.some((n) => n > 255)) return false; // not a real IPv4 literal
    return (
      o[0] === 127 || // 127/8 loopback
      o[0] === 10 || // 10/8
      o[0] === 0 || // 0/8 ("this network" — reaches localhost on some stacks)
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || // 172.16/12
      (o[0] === 192 && o[1] === 168) || // 192.168/16
      (o[0] === 169 && o[1] === 254) // 169.254/16 link-local (cloud metadata)
    );
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true; // loopback / unspecified
    if (/^f[cd]/.test(host)) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
  }
  return false;
}

/** Returns null when the host may be called, else an error envelope. */
function hostPolicy(hostRaw) {
  const host = hostRaw.toLowerCase().replace(/^\[|\]$/g, "");
  const list = cfg.allowlist;
  const explicit = list.includes(host);
  if (isPrivateHost(host)) {
    if (explicit) return null; // explicit listing is informed operator consent
    return errEnv(
      "private_host_blocked",
      `Host "${host}" is a loopback/private/link-local address; egress to private hosts is always denied unless that exact host is explicitly listed in HTTP_ALLOWED_HOSTS.`,
      false,
      `Wildcards and "*" never cover private hosts. If you really mean to call a local service, ask the operator to add "${host}" explicitly to HTTP_ALLOWED_HOSTS.`
    );
  }
  if (explicit) return null;
  for (const entry of list) {
    if (entry === "*") return null; // all PUBLIC hosts (private handled above)
    if (entry.startsWith("*.") && host.endsWith(entry.slice(1))) return null;
  }
  return errEnv(
    "not_allowlisted",
    `Host "${host}" is not in HTTP_ALLOWED_HOSTS; egress denied.`,
    false,
    `Current allowlist: ${
      list.length ? "[" + list.join(", ") + "]" : "(empty — ALL egress is denied by default)"
    }. Ask the operator to add "${host}" (exact, or a "*.suffix" wildcard) to HTTP_ALLOWED_HOSTS in the MCP server env. Do not retry until the allowlist changes.`
  );
}

// ---------------------------------------------------------------------------
// Envelopes + audit
// ---------------------------------------------------------------------------

function errEnv(code, message, retryable, fixHint, extra = {}) {
  return {
    ok: false,
    error: { code, message: scrub(message), retryable, ...extra, fix_hint: scrub(fixHint) },
  };
}

/** One JSON audit line per call, to STDERR (stdout is JSON-RPC only). */
function audit(tool, urlObj, method, status, bytes, t0) {
  const line = {
    audit: "http_call",
    tool,
    host: urlObj.hostname.replace(/^\[|\]$/g, ""),
    method,
    path: urlObj.pathname, // deliberately NO query string (may carry tokens)
    status,
    bytes,
    ms: Date.now() - t0,
  };
  process.stderr.write(scrub(JSON.stringify(line)) + "\n");
}

// ---------------------------------------------------------------------------
// Header + auth helpers
// ---------------------------------------------------------------------------

const stripCRLF = (s) => String(s).replace(/[\r\n]+/g, ""); // header-injection guard

function envNameFor(host) {
  return "HTTP_AUTH_" + host.toUpperCase().replace(/^\[|\]$/g, "").replace(/[^A-Z0-9]+/g, "_");
}

const hasHeaderCI = (h, name) =>
  Object.keys(h).some((k) => k.toLowerCase() === name.toLowerCase());
const deleteHeaderCI = (h, name) => {
  for (const k of Object.keys(h)) if (k.toLowerCase() === name.toLowerCase()) delete h[k];
};

/**
 * Inject HTTP_AUTH_<HOST> ("Header-Name: value") when the caller didn't
 * set that header. Returns the injected header name, or null.
 */
function injectAuth(headers, host) {
  const line = process.env[envNameFor(host)];
  if (!line) return null;
  const i = line.indexOf(":");
  if (i <= 0) {
    process.stderr.write(`{"warn":"malformed ${envNameFor(host)} (expected 'Header: value'); ignored"}\n`);
    return null;
  }
  const name = stripCRLF(line.slice(0, i).trim());
  const value = stripCRLF(line.slice(i + 1).trim());
  if (!name || !value || hasHeaderCI(headers, name)) return null;
  headers[name] = value;
  return name;
}

function parseRetryAfter(raw) {
  if (!raw) return undefined;
  const secs = parseInt(raw, 10);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
}

// ---------------------------------------------------------------------------
// Response reading with a hard byte cap. We stream and cancel rather than
// buffering, so a 2 GB response costs us max_response_bytes, not 2 GB.
// ---------------------------------------------------------------------------

async function readCapped(res, maxBytes) {
  if (!res.body) return { buf: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    if (total + chunk.length > maxBytes) {
      chunks.push(chunk.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return { buf: Buffer.concat(chunks, total), truncated };
}

// ---------------------------------------------------------------------------
// Core request pipeline (shared by http_request / http_get_json / paginate).
// Redirects are handled MANUALLY: each hop is re-validated against the
// allowlist, and Authorization + injected auth are dropped when a redirect
// crosses to a different host (then re-injected if THAT host has its own
// HTTP_AUTH_* var). Max 5 hops.
// ---------------------------------------------------------------------------

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

async function performRequest(tool, methodIn, urlIn, headersIn, bodyIn, timeoutMsIn) {
  const t0 = Date.now();

  // --- validate args ---
  const method = String(methodIn || "GET").toUpperCase();
  if (!METHODS.includes(method))
    return errEnv("invalid_args", `Unsupported method "${methodIn}".`, false,
      `Use one of ${METHODS.join(", ")}.`);
  let u;
  try {
    u = new URL(String(urlIn));
  } catch {
    return errEnv("invalid_args", `"${urlIn}" is not a valid absolute URL.`, false,
      "Pass a full URL including scheme, e.g. https://api.example.com/path.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return errEnv("invalid_args", `Unsupported scheme "${u.protocol}".`, false,
      "Only http: and https: URLs are allowed.");
  if ((method === "GET" || method === "HEAD") && bodyIn !== undefined && bodyIn !== null)
    return errEnv("invalid_args", `${method} requests cannot carry a body.`, false,
      "Drop the body, or use POST/PUT/PATCH.");
  if (headersIn !== undefined && (typeof headersIn !== "object" || headersIn === null || Array.isArray(headersIn)))
    return errEnv("invalid_args", "headers must be an object of string values.", false,
      'Pass headers like {"Accept": "application/json"}.');

  const callerHeaders = {};
  for (const [k, v] of Object.entries(headersIn || {})) callerHeaders[stripCRLF(k)] = stripCRLF(String(v));

  let bodyPayload;
  let bodyIsJson = false;
  if (bodyIn !== undefined && bodyIn !== null) {
    if (typeof bodyIn === "string") bodyPayload = bodyIn;
    else {
      bodyPayload = JSON.stringify(bodyIn);
      bodyIsJson = true;
    }
  }

  let timeoutMs = cfg.timeoutMs;
  if (timeoutMsIn !== undefined && timeoutMsIn !== null) {
    const t = parseInt(timeoutMsIn, 10);
    if (!Number.isFinite(t) || t < 1)
      return errEnv("invalid_args", `timeout_ms must be a positive integer (got ${timeoutMsIn}).`, false,
        "Pass timeout_ms in milliseconds, e.g. 30000.");
    timeoutMs = Math.min(t, 600000);
  }

  // --- redirect-following loop with per-hop policy re-validation ---
  const firstHost = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let current = u;
  let curMethod = method;
  let curBody = bodyPayload;
  let hops = 0;
  let finalAuthSent = false;
  let res;

  try {
    for (;;) {
      const denied = hostPolicy(current.hostname);
      if (denied) {
        clearTimeout(timer);
        audit(tool, current, curMethod, null, 0, t0);
        return denied;
      }
      const hopHost = current.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      const h = { ...callerHeaders };
      // Never carry credentials across a cross-host redirect.
      if (hopHost !== firstHost) deleteHeaderCI(h, "authorization");
      const injectedName = injectAuth(h, hopHost);
      finalAuthSent = !!injectedName || hasHeaderCI(h, "authorization");
      if (bodyIsJson && curBody !== undefined && !hasHeaderCI(h, "content-type"))
        h["Content-Type"] = "application/json";

      res = await fetch(current.toString(), {
        method: curMethod,
        headers: h,
        body: curBody,
        redirect: "manual",
        signal: ac.signal,
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        if (!loc) break; // 3xx with no Location: return it as data
        res.body?.cancel?.().catch?.(() => {});
        if (hops >= MAX_REDIRECTS) {
          clearTimeout(timer);
          audit(tool, current, curMethod, res.status, 0, t0);
          return errEnv("network_error", `Stopped after ${MAX_REDIRECTS} redirects (last hop: ${hopHost}).`,
            false, "The target redirects too many times; call the final URL directly.");
        }
        hops++;
        // 303 (and 301/302 on non-GET, per browser convention) demote to GET.
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && curMethod !== "GET" && curMethod !== "HEAD")) {
          curMethod = "GET";
          curBody = undefined;
        }
        current = new URL(loc, current);
        continue;
      }
      break;
    }

    // --- body + envelope ---
    const { buf, truncated } = await readCapped(res, cfg.maxBytes);
    clearTimeout(timer);
    const ct = res.headers.get("content-type") || "";
    let body = buf.toString("utf8");
    let note;
    if (/\bjson\b/i.test(ct)) {
      try {
        body = JSON.parse(body);
      } catch {
        note = truncated
          ? `response exceeded HTTP_MAX_RESPONSE_BYTES (${cfg.maxBytes}); truncated partial JSON returned as raw text`
          : "content-type declares JSON but the body did not parse; returned as raw text";
      }
    }

    // Policy failure, not data: 401 with NO credential sent and none
    // configured is unfixable by retrying — name the exact env var.
    if (res.status === 401 && !finalAuthSent && !process.env[envNameFor(current.hostname.toLowerCase().replace(/^\[|\]$/g, ""))]) {
      audit(tool, current, curMethod, res.status, buf.length, t0);
      return errEnv("missing_auth",
        `401 Unauthorized from ${current.hostname} and no credential is configured for it.`,
        false,
        `Set the env var ${envNameFor(current.hostname)} in the MCP server environment to a full header line, e.g. "Authorization: Bearer <token>". Do not retry; ask the operator to configure the credential. Never paste the token into chat.`);
    }

    const env = {
      ok: true, // 4xx/5xx are DATA, not transport failure — status carries it
      status: res.status,
      content_type: ct,
      returned_bytes: buf.length,
      truncated,
      body,
    };
    if (res.status === 429) {
      const ra = parseRetryAfter(res.headers.get("retry-after"));
      if (ra !== undefined) env.retry_after_ms = ra;
    }
    if (truncated && !note) note = `response exceeded HTTP_MAX_RESPONSE_BYTES (${cfg.maxBytes}); body truncated`;
    if (note) env.note = scrub(note);
    audit(tool, current, curMethod, res.status, buf.length, t0);
    return env;
  } catch (e) {
    clearTimeout(timer);
    audit(tool, current, curMethod, null, 0, t0);
    if (e?.name === "AbortError" || ac.signal.aborted)
      return errEnv("timeout", `Request to ${current.hostname} timed out after ${timeoutMs} ms.`, true,
        "Safe to retry; pass a larger timeout_ms if the service is just slow.");
    return errEnv("network_error",
      `Fetch failed for ${current.hostname}: ${e?.cause?.code || e?.message || String(e)}.`, true,
      "Transport-level failure (DNS, TLS, connection reset). Check the host and retry.");
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolHttpRequest(args) {
  return performRequest("http_request", args.method, args.url, args.headers, args.body, args.timeout_ms);
}

async function toolHttpGetJson(args) {
  const headers = { Accept: "application/json", ...(args.headers || {}) };
  return performRequest("http_get_json", "GET", args.url, headers, undefined, undefined);
}

async function toolHttpPaginate(args) {
  let base;
  try {
    base = new URL(String(args.url));
  } catch {
    return errEnv("invalid_args", `"${args.url}" is not a valid absolute URL.`, false,
      "Pass a full URL including scheme.");
  }
  const param = args.param ? String(args.param) : "page";
  const start = Number.isInteger(args.start) ? args.start : 1;
  let pages = Number.isInteger(args.pages) ? args.pages : 3;
  pages = Math.max(1, Math.min(MAX_PAGES, pages));

  const merged = [];
  let fetched = 0, totalBytes = 0, truncatedAny = false, lastStatus = null, note;

  for (let i = 0; i < pages; i++) {
    const pu = new URL(base);
    pu.searchParams.set(param, String(start + i));
    const env = await performRequest("http_paginate", "GET",
      pu.toString(), { Accept: "application/json", ...(args.headers || {}) }, undefined, undefined);
    if (!env.ok) return env; // policy/transport error: propagate as-is
    fetched++;
    lastStatus = env.status;
    totalBytes += env.returned_bytes;
    truncatedAny = truncatedAny || env.truncated;
    const arr = Array.isArray(env.body)
      ? env.body
      : env.body && Array.isArray(env.body.items) ? env.body.items : null;
    if (arr === null) {
      if (fetched === 1)
        return errEnv("invalid_args",
          `Paginate target did not return a JSON array (status ${env.status}); http_paginate only merges a top-level array or an "items" array.`,
          false, "Use http_get_json / http_request for this endpoint, or check the URL and auth.");
      note = `page ${start + i} did not return an array; stopped and returned pages merged so far`;
      break;
    }
    merged.push(...arr);
    if (arr.length === 0) {
      note = `page ${start + i} returned an empty array; stopped early`;
      break;
    }
  }

  const env = {
    ok: true,
    status: lastStatus,
    content_type: "application/json",
    returned_bytes: totalBytes,
    truncated: truncatedAny,
    pages_fetched: fetched,
    body: merged,
  };
  if (note) env.note = note;
  return env;
}

function toolHttpCapabilities() {
  // Names + existence only. NEVER read secret values into output.
  const authEnvVars = Object.keys(process.env)
    .filter((k) => k.startsWith("HTTP_AUTH_") && process.env[k])
    .sort();
  const authConfiguredHosts = cfg.allowlist
    .filter((h) => !h.includes("*"))
    .filter((h) => !!process.env[envNameFor(h)]);

  const connections = [];
  try {
    for (const entry of readdirSync(cfg.connectionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let spec;
      try {
        spec = JSON.parse(readFileSync(join(cfg.connectionsDir, entry.name, "connection.json"), "utf8"));
      } catch {
        continue; // unreadable/invalid spec: skip, best-effort scan
      }
      const c = {
        name: spec.name ?? entry.name,
        type: spec.type,
        display_name: spec.display?.display_name,
        env: spec.env,
      };
      if (spec.type === "rest") {
        c.base_url = spec.base_url;
        let host = null;
        try { host = new URL(spec.base_url).hostname; } catch {}
        c.auth = spec.auth ? (host && process.env[envNameFor(host)] ? "configured" : "missing") : "configured";
      } else if (spec.type === "mcp") {
        c.transport = spec.transport;
        // Best-effort: every {{secret:NAME}} ref must have NAME (upper,
        // dashes->underscores) present in env. Existence check only.
        const refs = [];
        for (const bag of [spec.env_bindings, spec.headers]) {
          for (const v of Object.values(bag || {})) {
            if (typeof v !== "string") continue;
            for (const m of v.matchAll(/\{\{secret:([a-z0-9-]+)\}\}/g)) refs.push(m[1]);
          }
        }
        c.auth = refs.every((r) => !!process.env[r.toUpperCase().replace(/-/g, "_")])
          ? "configured" : "missing";
      }
      connections.push(c);
    }
  } catch {
    // missing dir => connections: []
  }

  return {
    ok: true,
    allowed_hosts: cfg.allowlist,
    auth_configured_hosts: authConfiguredHosts,
    auth_env_vars: authEnvVars,
    defaults: {
      timeout_ms: cfg.timeoutMs,
      max_response_bytes: cfg.maxBytes,
      connections_dir: cfg.connectionsDir,
    },
    connections,
  };
}

// ---------------------------------------------------------------------------
// Tool declarations (tools/list)
// ---------------------------------------------------------------------------

const HEADERS_SCHEMA = {
  type: "object",
  additionalProperties: { type: "string" },
  description:
    "Extra request headers. Auth for a configured host is injected automatically from HTTP_AUTH_<HOST>; never put secret values here.",
};

const TOOLS = [
  {
    name: "http_request",
    description:
      "Make one HTTP request to an allowlisted host and get a JSON envelope back: {ok:true, status, content_type, returned_bytes, truncated, body} — HTTP 4xx/5xx come back as ok:true with the status (they are data). Policy/transport failures come back as {ok:false, error:{code, message, retryable, fix_hint}}. Egress is deny-by-default (HTTP_ALLOWED_HOSTS); private/loopback hosts are blocked unless explicitly listed; redirects are followed up to 5 hops and re-validated per hop. Non-GET calls against real services need explicit user intent — confirm before writing.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: METHODS, description: "HTTP method. Anything except GET/HEAD/OPTIONS is a write — confirm user intent first." },
        url: { type: "string", description: "Absolute http(s) URL. Host must pass the allowlist." },
        headers: HEADERS_SCHEMA,
        body: { description: "Request body: a string is sent as-is; an object is JSON-encoded (Content-Type: application/json unless overridden). Not allowed on GET/HEAD." },
        timeout_ms: { type: "integer", minimum: 1, description: `Per-request timeout override in ms (default ${cfg.timeoutMs}).` },
      },
      required: ["method", "url"],
    },
  },
  {
    name: "http_get_json",
    description:
      "Convenience GET for JSON APIs: sends Accept: application/json and parses a JSON body when the content-type declares it (body comes back as a parsed object, or raw text with a note when parsing fails). Same envelope, allowlist, auth injection, byte cap, and redirect policy as http_request.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to GET." },
        headers: HEADERS_SCHEMA,
      },
      required: ["url"],
    },
  },
  {
    name: "http_paginate",
    description:
      'Fetch several page-numbered pages of a JSON list endpoint in one call and merge them. Page-style pagination only: sets the page query param (default "page") from start (default 1) for up to pages pages (default 3, max 10), merging a top-level JSON array or a top-level "items" array. Stops early on an empty page. Envelope adds pages_fetched and body is the merged array. Fix page size in the url yourself (e.g. ?per_page=50).',
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL of the list endpoint, WITHOUT the page param (it is set per page)." },
        param: { type: "string", description: 'Query param that carries the page number. Default "page".' },
        start: { type: "integer", description: "First page number. Default 1." },
        pages: { type: "integer", minimum: 1, maximum: MAX_PAGES, description: `How many pages to fetch. Default 3, max ${MAX_PAGES}.` },
        headers: HEADERS_SCHEMA,
      },
      required: ["url"],
    },
  },
  {
    name: "http_capabilities",
    description:
      "Introspect this HTTP tool's live configuration: allowed_hosts (the egress allowlist), which hosts/env vars have auth configured (names only — never values), default timeout and byte cap, and the connection specs found in HTTP_CONNECTIONS_DIR (name, type, base_url/transport, display_name, env, auth configured|missing). Call this first when a request was denied or you are unsure what you can reach.",
    inputSchema: { type: "object", properties: {} },
  },
];

const IMPL = {
  http_request: toolHttpRequest,
  http_get_json: toolHttpGetJson,
  http_paginate: toolHttpPaginate,
  http_capabilities: async () => toolHttpCapabilities(),
};

// ---------------------------------------------------------------------------
// MCP stdio transport: newline-delimited JSON-RPC 2.0 on stdin/stdout.
// STDOUT carries ONLY JSON-RPC frames; everything else goes to stderr.
// The process must survive garbage input (-32700) and unknown methods
// (-32601), and must not exit while tool calls are still in flight.
// ---------------------------------------------------------------------------

let pending = 0;
let stdinDone = false;
function maybeExit() {
  if (stdinDone && pending === 0) process.exit(0);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
const sendResult = (id, result) => send({ jsonrpc: "2.0", id, result });
const sendError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handleToolCall(id, params) {
  const name = params?.name;
  const impl = IMPL[name];
  if (!impl) {
    sendError(id, -32602, `Unknown tool: ${name}`);
    return;
  }
  let envelope;
  try {
    envelope = await impl(params?.arguments ?? {});
  } catch (e) {
    envelope = errEnv("network_error", `Unexpected server error: ${e?.message || String(e)}.`, false,
      "This is a bug in mcp-http-server.mjs; report it with the request that triggered it.");
  }
  sendResult(id, {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    isError: envelope.ok === false,
  });
}

function handleMessage(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case "initialize":
      sendResult(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "rasa-module-http", version: VERSION },
      });
      break;
    case "notifications/initialized":
      break; // no-op
    case "ping":
      if (isRequest) sendResult(id, {});
      break;
    case "tools/list":
      sendResult(id, { tools: TOOLS });
      break;
    case "tools/call":
      pending++;
      handleToolCall(id, params).finally(() => {
        pending--;
        maybeExit();
      });
      break;
    default:
      if (isRequest) sendError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    sendError(null, -32700, "Parse error: line was not valid JSON");
    return; // never crash on garbage
  }
  if (Array.isArray(msg) || typeof msg !== "object" || msg === null || typeof msg.method !== "string") {
    if (msg && msg.id !== undefined) sendError(msg.id, -32600, "Invalid Request");
    return;
  }
  handleMessage(msg);
});
rl.on("close", () => {
  stdinDone = true;
  maybeExit();
});

process.stderr.write(
  `{"info":"rasa-module-http v${VERSION} up","allowed_hosts":${JSON.stringify(cfg.allowlist)},"timeout_ms":${cfg.timeoutMs},"max_response_bytes":${cfg.maxBytes}}\n`
);

// Schemas of the control events (JSON text frames on /ws). The gateway accepts only the events declared
// here, with exactly the declared fields: an unknown event, an unknown or missing field, a wrong type, a
// number out of range or a string too long is refused (the server takes no data it did not ask for). The
// binary input frame is checked by size here and by layout in the match worker (shared/codec.ts decodeInput,
// net/validate.ts).

import { MAX_INPUT_BYTES as MAX_INPUT } from "@cs/shared/codec";

export const MATCH_ID_RE = /^[0-9a-f]{8}$/;
export const ITEM_RE = /^[a-z0-9_]{1,32}$/;
export const LOBBY_CODE_RE = /^[A-Za-z0-9]{6}$/;
export const TOKEN_RE = /^[A-Za-z0-9_-]{8,32}$/;
export const READY_RE = /^[0-9a-f]{16}$/;
export const SERVER_ID_RE = /^[a-z0-9-]{1,32}$/;
export const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
export const MAX_INPUT_BYTES = MAX_INPUT;

export class SchemaError extends Error {}

type Kind = "string" | "number" | "integer" | "boolean" | "object";
interface Spec {
  type: Kind | Kind[];
  required?: boolean;
  min?: number;
  max?: number;
  choices?: unknown[];
  maxLen?: number;
  pattern?: RegExp;
  nullable?: boolean;
}

const S = (type: Spec["type"], extra: Omit<Spec, "type"> = {}): Spec => ({ type, required: true, ...extra });

export const EVENTS: Record<string, Record<string, Spec>> = {
  "match:list": {},
  "match:join": { match_id: S("string", { pattern: MATCH_ID_RE }), as: S("string", { required: false, choices: ["play", "spectate"] }),
    team: S("integer", { required: false, choices: [0, 1], nullable: true }) },
  "match:leave": {},
  "match:stop": { match_id: S("string", { pattern: MATCH_ID_RE }) },
  ping: { t: S("number", { min: 0, max: 2 ** 53 }) },
  buy: { item: S("string", { maxLen: 32, pattern: ITEM_RE }) },
  sell: { item: S("string", { maxLen: 32, pattern: ITEM_RE }) },
  specialist: { item: S("string", { maxLen: 32, pattern: ITEM_RE }) },
  "lobby:create": { settings: S("object", { required: false, maxLen: 10 }) },
  "lobby:join": { code: S("string", { pattern: LOBBY_CODE_RE }) },
  "lobby:leave": {},
  "lobby:update": { settings: S("object", { maxLen: 10 }) },
  "lobby:team": { team: S(["integer", "string"], { choices: [0, 1, "spectate"] }) },
  "lobby:start": {},
  "lobby:reopen": {},
  "queue:join": { mode: S("string", { choices: ["duel_ranked"] }) },
  "queue:leave": { mode: S("string", { required: false, choices: ["duel_ranked"] }) },
  "challenge:send": { username: S("string", { required: false, pattern: USERNAME_RE }) },
  "challenge:respond": { token: S("string", { pattern: TOKEN_RE }), accept: S("boolean") },
  ready: { match_token: S("string", { pattern: READY_RE }), ready: S("boolean") },
  "browser:watch": {},
  "browser:unwatch": {},
  "server:join": { server_id: S("string", { pattern: SERVER_ID_RE }), as: S("string", { required: false, choices: ["play", "spectate"] }) },
  "vote:kick": { target: S("integer", { min: 1, max: 65535 }) },
  "vote:cast": { yes: S("boolean") },
  chat: { scope: S("string", { choices: ["all", "team", "lobby"] }), text: S("string", { maxLen: 400 }) },
};

function typeOk(kind: Kind, v: unknown): boolean {
  switch (kind) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "object": return typeof v === "object" && v !== null && !Array.isArray(v);
  }
}

function check(name: string, spec: Spec, value: unknown): unknown {
  if (value === null) {
    if (spec.nullable) return null;
    throw new SchemaError(`${name}: required`);
  }
  const kinds = Array.isArray(spec.type) ? spec.type : [spec.type];
  if (!kinds.some((k) => typeOk(k, value))) throw new SchemaError(`${name}: wrong type`);
  if (typeof value === "number") {
    if (spec.min !== undefined && value < spec.min) throw new SchemaError(`${name}: below ${spec.min}`);
    if (spec.max !== undefined && value > spec.max) throw new SchemaError(`${name}: above ${spec.max}`);
  }
  if (spec.maxLen !== undefined) {
    const len = typeof value === "string" ? value.length : typeof value === "object" ? Object.keys(value as object).length : 0;
    if (len > spec.maxLen) throw new SchemaError(`${name}: longer than ${spec.maxLen}`);
  }
  if (spec.choices && !spec.choices.includes(value)) throw new SchemaError(`${name}: not one of ${spec.choices.join(", ")}`);
  if (spec.pattern && !spec.pattern.test(value as string)) throw new SchemaError(`${name}: bad format`);
  return value;
}

/** The checked fields of a control event (defaults left out), or SchemaError. */
export function validate(event: string, data: unknown): Record<string, any> {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const schema = Object.prototype.hasOwnProperty.call(EVENTS, event) ? EVENTS[event] : undefined;
  if (!schema) throw new SchemaError(`unknown event ${JSON.stringify(event).slice(0, 40)}`);
  const d = data === undefined || data === null ? {} : data;
  if (typeof d !== "object" || Array.isArray(d)) throw new SchemaError("expected an object");
  const obj = d as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (!(k in schema)) throw new SchemaError(`unknown field ${JSON.stringify(k)}`);
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema)) {
    if (!(name in obj)) {
      if (spec.required) throw new SchemaError(`${name}: required`);
      continue;
    }
    out[name] = check(name, spec, obj[name]);
  }
  return out;
}

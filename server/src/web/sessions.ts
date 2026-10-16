// Signed session cookies and CSRF tokens. The session is a small JSON payload in an HttpOnly, SameSite=Lax
// cookie, signed with HMAC-SHA256 over SECRET_KEY (Secure behind HTTPS): a random nonce, the user id once
// logged in, whether to remember the log-in, when it was issued and pending flash messages. A new nonce is
// drawn at every log-in and log-out (no session fixation). The CSRF token of a session is an HMAC of its
// nonce; every form and every state-changing API call must carry it (form field csrf_token or header
// X-CSRF-Token).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE = "cs_session";
const SESSION_DAYS = 7;          // a log-in without "keep me logged in" (the cookie itself ends with the browser)
const REMEMBER_DAYS = 30;

export interface Session {
  n: string;                     // nonce
  u?: number;                    // user id
  r?: 1;                         // remember
  t: number;                     // issued (epoch seconds)
  f?: Array<[string, string]>;   // flash messages [category, text]
}

export class SessionCodec {
  constructor(private secret: string, public secure: boolean) {}

  private sign(data: string): string { return createHmac("sha256", this.secret).update(data).digest("base64url"); }

  fresh(): Session { return { n: randomBytes(16).toString("base64url"), t: Math.floor(Date.now() / 1000) }; }

  encode(s: Session): string {
    const body = Buffer.from(JSON.stringify(s)).toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  decode(value: string | undefined): Session | null {
    if (!value) return null;
    const dot = value.lastIndexOf(".");
    if (dot < 1) return null;
    const body = value.slice(0, dot);
    const sig = Buffer.from(value.slice(dot + 1));
    const want = Buffer.from(this.sign(body));
    if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
    try {
      const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
      if (typeof s.n !== "string" || typeof s.t !== "number") return null;
      const maxAge = (s.r ? REMEMBER_DAYS : SESSION_DAYS) * 86400;
      if (s.u !== undefined && Date.now() / 1000 - s.t > maxAge) return { n: s.n, t: s.t };
      return s;
    } catch {
      return null;
    }
  }

  /** The Set-Cookie options for a session. */
  cookieOptions(s: Session): { httpOnly: true; sameSite: "lax"; secure: boolean; path: string; maxAge?: number } {
    return { httpOnly: true, sameSite: "lax", secure: this.secure, path: "/", ...(s.r ? { maxAge: REMEMBER_DAYS * 86400 } : {}) };
  }

  csrf(s: Session): string { return createHmac("sha256", this.secret).update(`csrf:${s.n}`).digest("base64url").slice(0, 32); }

  checkCsrf(s: Session, token: unknown): boolean {
    if (typeof token !== "string") return false;
    const a = Buffer.from(token), b = Buffer.from(this.csrf(s));
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/** Cookie header -> value of one cookie (for the WebSocket upgrade, which has no cookie plugin). */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

// The real client address and scheme behind a reverse proxy (Cloudflare, cloudflared, nginx). Behind a proxy
// every request arrives from the proxy's address over plain HTTP; left alone, every player would share one
// IP for the failed-login limit and the WebSocket origin check would compare https:// pages with http://.
// TRUSTED_PROXY chooses what to believe:
// * none (default): the TCP peer is the client; no header is trusted.
// * cloudflare: CF-Connecting-IP and X-Forwarded-Proto are trusted when the request comes from Cloudflare's
//   published ranges (CLOUDFLARE_IPS overrides them), or from this machine (a Cloudflare Tunnel's cloudflared
//   connects from localhost). Anyone else sending those headers is ignored.
// * local: one proxy on this machine (nginx, caddy): X-Forwarded-For (its last entry) and X-Forwarded-Proto
//   are trusted from localhost only.
// Applied to every HTTP request and to the WebSocket upgrade.

import type { IncomingHttpHeaders } from "node:http";
import { BlockList, isIP } from "node:net";
import type { TrustedProxy } from "../config";

// https://www.cloudflare.com/ips/ (they change rarely)
export const CLOUDFLARE_RANGES = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];
const LOCAL_RANGES = ["127.0.0.0/8", "::1/128"];

function blockList(ranges: string[]): BlockList {
  const bl = new BlockList();
  for (const r of ranges) {
    const [addr, bits] = r.trim().split("/");
    const fam = isIP(addr) === 6 ? "ipv6" : "ipv4";
    if (!isIP(addr)) continue;
    bl.addSubnet(addr, Number(bits ?? (fam === "ipv6" ? 128 : 32)), fam);
  }
  return bl;
}

/** "::ffff:1.2.3.4" -> "1.2.3.4" (Node reports IPv4 peers on dual-stack sockets that way). */
export function normIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  let s = ip.trim();
  if (s.startsWith("::ffff:") && isIP(s.slice(7)) === 4) s = s.slice(7);
  return isIP(s) ? s : null;
}

function inList(bl: BlockList, ip: string | null): boolean {
  if (!ip) return false;
  return bl.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
}

export class ProxyTrust {
  private local = blockList(LOCAL_RANGES);
  private cloudflare: BlockList;

  constructor(public mode: TrustedProxy, cloudflareRanges: string[] | null = null) {
    this.cloudflare = blockList(cloudflareRanges ?? CLOUDFLARE_RANGES);
  }

  /** [client ip, scheme] for a request from `peer` with these headers. */
  resolve(peer: string | undefined, headers: IncomingHttpHeaders, encrypted = false): { ip: string; proto: "http" | "https" } {
    const p = normIp(peer);
    let client: string | null = null;
    let proto: string | undefined;
    const h = (name: string) => {
      const v = headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    if (this.mode === "cloudflare" && (inList(this.cloudflare, p) || inList(this.local, p))) {
      client = normIp(h("cf-connecting-ip"));
      proto = h("x-forwarded-proto");
      if (!proto && (h("cf-visitor") ?? "").includes("https")) proto = "https";
    } else if (this.mode === "local" && inList(this.local, p)) {
      const fwd = (h("x-forwarded-for") ?? "").split(",");
      client = normIp(fwd[fwd.length - 1]);
      proto = h("x-forwarded-proto");
    }
    let scheme: "http" | "https" = encrypted ? "https" : "http";
    if (proto) {
      const v = proto.split(",")[0].trim().toLowerCase();
      if (v === "http" || v === "https") scheme = v;
    }
    return { ip: client ?? p ?? "?", proto: scheme };
  }
}

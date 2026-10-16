// Chat: the word filter and the rate limit. ChatFilter.clean masks every word of data/chat_filter.json
// (****); usernameOk checks a new account's name against the same list. ChatLimiter allows 5 messages per
// 10 s per account. Messages are at most 200 characters, control characters removed.

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../paths";

export const MAX_LEN = 200;
const LEET: Record<string, string> = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", $: "s",
  "7": "t", "+": "t", "8": "b", "9": "g" };

/** Runs of one letter become one letter (fuuuck -> fuck). */
const collapse = (s: string) => s.replace(/(.)\1+/g, "$1");

/** Lower case, accents and leetspeak undone, letters only. */
export function normalize(word: string, doCollapse = false): string {
  let w = word.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  w = [...w].map((ch) => LEET[ch] ?? ch).join("").replace(/[^a-z]/g, "");
  return doCollapse ? collapse(w) : w;
}

/** No control or format characters, single spaces, at most MAX_LEN. */
export function sanitize(text: string): string {
  return String(text).replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
}

export class ChatFilter {
  stems: string[];
  words: Set<string>;
  private stemsC: string[];
  private wordsC: Set<string>;

  constructor(file = path.join(DATA_DIR, "chat_filter.json")) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    this.stems = (data.stems ?? []).map((w: string) => w.toLowerCase());
    this.words = new Set((data.words ?? []).map((w: string) => w.toLowerCase()));
    // stretched spellings are compared collapsed, with the list collapsed too
    this.stemsC = this.stems.map(collapse);
    this.wordsC = new Set([...this.words].map(collapse));
  }

  bad(word: string): boolean {
    const w = normalize(word);
    if (!w) return false;
    if (this.words.has(w) || this.stems.some((s) => w.startsWith(s))) return true;
    const c = collapse(w);
    return c !== w && (this.wordsC.has(c) || this.stemsC.some((s) => c.startsWith(s)));
  }

  /** [text with bad words masked, whether anything was masked]. Letters spaced out one by one ("f u c k")
   * are read as one word too. */
  clean(input: string): [string, boolean] {
    const text = sanitize(input);
    const spans: Array<[number, number]> = [];
    for (const m of text.matchAll(/\S+/g)) spans.push([m.index as number, (m.index as number) + m[0].length]);
    const mask = spans.map(([a, b]) => this.bad(text.slice(a, b)));
    let i = 0;
    while (i < spans.length) {                       // runs of single characters
      let j = i;
      while (j < spans.length && spans[j][1] - spans[j][0] === 1) j++;
      if (j - i >= 3 && this.bad(spans.slice(i, j).map(([a, b]) => text.slice(a, b)).join(""))) for (let k = i; k < j; k++) mask[k] = true;
      i = Math.max(j, i + 1);
    }
    if (!mask.some(Boolean)) return [text, false];
    let out = "", last = 0;
    spans.forEach(([a, b], k) => {
      out += text.slice(last, a) + (mask[k] ? "*".repeat(b - a) : text.slice(a, b));
      last = b;
    });
    return [out + text.slice(last), true];
  }

  /** No stem anywhere in the name, no listed word as one of its parts (split on _ and -, and between lower
   * and upper case). */
  usernameOk(name: string): boolean {
    const flat = normalize(name);
    if (this.stems.some((s) => flat.includes(s)) || this.stemsC.some((s) => collapse(flat).includes(s))) return false;
    const parts = name.split(/[_-]+|(?<=[a-z])(?=[A-Z])/);
    return !parts.some((p) => p && this.bad(p));
  }
}

let filter: ChatFilter | null = null;
export function wordFilter(): ChatFilter {
  filter ??= new ChatFilter();
  return filter;
}

/** n messages per window seconds per key. */
export class ChatLimiter {
  private sent = new Map<number | string, number[]>();
  constructor(public n = 5, public window = 10, private clock: () => number = () => performance.now() / 1000) {}

  /** [allowed, seconds until the next message is allowed]. */
  allow(key: number | string): [boolean, number] {
    const now = this.clock();
    const times = (this.sent.get(key) ?? []).filter((t) => now - t < this.window);
    if (times.length >= this.n) {
      this.sent.set(key, times);
      return [false, this.window - (now - times[0])];
    }
    times.push(now);
    this.sent.set(key, times);
    if (this.sent.size > 5000) for (const [k, v] of this.sent) if (!v.length || now - v[v.length - 1] >= this.window) this.sent.delete(k);
    return [true, 0];
  }
}

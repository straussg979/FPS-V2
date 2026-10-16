// `npm run fetch-assets` (optional): downloads the HDR skies the maps name (environment.hdri, then
// environment.hdri_candidates) from Poly Haven, CC0, into assets-cache/hdri. The next `npm start` builds
// them into the game assets; without them the client draws a procedural sky. `--res=2k` for sharper skies.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "assets-cache", "hdri");
const RES = process.argv.find((a) => a.startsWith("--res="))?.slice(6) ?? "1k";
const FORCE = process.argv.includes("--force");
const API = "https://api.polyhaven.com";

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, "data", "maps")).filter((x) => x.endsWith(".json"))) {
  const env = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "maps", f), "utf8")).environment ?? {};
  for (const id of [env.hdri, ...(env.hdri_candidates ?? [])].filter(Boolean) as string[]) {
    const out = path.join(OUT, `${id}.hdr`);
    if (fs.existsSync(out) && !FORCE) { console.log(`${f}: ${id} already present`); break; }
    try {
      const files = await (await fetch(`${API}/files/${id}`, { headers: { "user-agent": "cold-sector-build" } })).json() as any;
      const url: string | undefined = files?.hdri?.[RES]?.hdr?.url;
      if (!url) throw new Error(`no ${RES} .hdr listed`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(out, data);
      console.log(`${f}: ${id} <- Poly Haven, CC0 (${(data.length / 1e6).toFixed(1)} MB)`);
      break;
    } catch (err) {
      console.log(`${f}: ${id} failed (${(err as Error).message}), trying the next candidate`);
    }
  }
}
console.log("Done. `npm start` builds the skies into the game assets.");

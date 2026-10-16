// Worker thread: one material's texture set (texgen.ts) at 1024 px and its 512 px reduction, as JPEGs.
import { parentPort } from "node:worker_threads";
import jpeg from "jpeg-js";
import { downsample, generate, seedFor } from "./texgen";

function jpg(rgb: Uint8Array, size: number, q: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data: rgba, width: size, height: size }, q).data);
}

parentPort!.on("message", (job: { name: string; def: Record<string, unknown>; size: number }) => {
  const proc = { ...((job.def.procedural as Record<string, unknown>) ?? { type: "flat" }) };
  const kind = String(proc.type ?? "flat");
  delete proc.type;
  const size = job.size;
  const p = generate(kind, proc, size, seedFor(job.name));
  const out: Record<string, Record<string, Uint8Array>> = {};
  const q: Record<string, number> = { albedo: 86, normal: 82, orm: 84 };
  for (const m of ["albedo", "normal", "orm"] as const) {
    const full = p[m];
    out[m] = { [String(size)]: jpg(full, size, q[m]), [String(size / 2)]: jpg(downsample(full, size), size / 2, q[m]) };
  }
  parentPort!.postMessage({ name: job.name, maps: out });
});

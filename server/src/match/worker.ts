// Worker-thread entry: one match per worker (worker_threads). The gateway posts InMessages; this runs the
// MatchServer's real-time loop and posts OutMessages back (snapshot buffers are transferred, not copied).

import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { fileCache, mapPath } from "../paths";
import { type InMessage, type MatchConfig, MatchServer, type OutMessage } from "./server";

const port = parentPort;
if (!port) throw new Error("worker.ts runs as a worker thread");

const cfg = workerData.config as MatchConfig;
const inbox: InMessage[] = [];
const post = (m: OutMessage, transfer?: ArrayBuffer[]) => port.postMessage(m, transfer ?? []);
const log = (text: string) => post({ t: "log", text });

port.on("message", (m: InMessage) => {
  if (m.t === "input" && !(m.data instanceof Uint8Array)) m.data = new Uint8Array(m.data as ArrayBufferLike);
  inbox.push(m);
});

try {
  const mapData = JSON.parse(fs.readFileSync(mapPath(cfg.map), "utf8"));
  const server = new MatchServer(cfg, mapData, post, log, fileCache());
  post({ t: "ready", info: { map: cfg.map } });
  await server.run(() => inbox.splice(0, inbox.length), () => post({ t: "stats", data: server.stats() }));
  post({ t: "closed", reason: server.reason });
} catch (e) {
  const err = e as Error;
  log(err.stack ?? String(err));
  post({ t: "closed", reason: `error: ${err.message}` });
}
port.close();

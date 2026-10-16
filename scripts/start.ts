// `npm start`: build what is missing or stale, then run the server in this same process, so a SIGTERM
// (docker stop, a service manager) or Ctrl+C reaches the server itself and it shuts down cleanly.

import { build } from "./build";

await build();
await import("../server/dist/main.mjs");

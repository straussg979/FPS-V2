// Development only (npm run dev / tsx): load the TypeScript worker through tsx's loader.
import { register } from "tsx/esm/api";

register();
await import("./worker.ts");

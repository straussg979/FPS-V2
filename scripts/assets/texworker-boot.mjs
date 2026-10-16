// The texture worker runs TypeScript: load it through tsx's loader.
import { register } from "tsx/esm/api";

register();
await import("./texworker.ts");

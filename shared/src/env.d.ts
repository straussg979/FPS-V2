// Web platform globals available in both Node and the browser (the shared code uses no other API).
declare class TextEncoder { encode(input?: string): Uint8Array }
declare class TextDecoder { constructor(label?: string); decode(input?: ArrayBufferView | ArrayBuffer): string }

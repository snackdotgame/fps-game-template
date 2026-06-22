import { NativeScope } from "../../node_modules/jolt-ts/dist/native.js";

export type JoltModule = Record<string, any> & {
  destroy(value: unknown): void;
};

export const joltWasmBuilds = [
  "wasm-compat",
  "wasm",
  "debug-wasm-compat",
  "wasm-compat-multithread",
  "wasm-multithread",
  "debug-wasm-compat-multithread",
] as const;

export type JoltWasmBuild = (typeof joltWasmBuilds)[number];
export type JoltBuild = JoltWasmBuild | "asm";
export type ExternalWasmBuild = "wasm" | "wasm-multithread";
export type EmbeddedWasmBuild =
  | "wasm-compat"
  | "debug-wasm-compat"
  | "wasm-compat-multithread"
  | "debug-wasm-compat-multithread";
export type UrlLike = { toString(): string; readonly href: string };

export interface LoadJoltOptions {
  readonly build?: JoltBuild;
  readonly locateFile?: (path: string, prefix: string) => string;
  readonly wasmUrl?: string | UrlLike;
  readonly module?: Record<string, unknown>;
}

export interface JoltRuntimeFeatures {
  readonly native: boolean;
  readonly wasm: boolean;
  readonly embeddedWasm: boolean;
  readonly externalWasm: boolean;
  readonly multithreaded: boolean;
  readonly simd: boolean;
  readonly debug: boolean;
  readonly crossPlatformDeterministic?: boolean;
}

export function featuresForBuild(build: JoltBuild): JoltRuntimeFeatures {
  return {
    native: true,
    wasm: build !== "asm",
    embeddedWasm: isEmbeddedWasmBuild(build),
    externalWasm: isExternalWasmBuild(build),
    multithreaded: build.includes("multithread"),
    simd: build.includes("multithread"),
    debug: build.includes("debug"),
    crossPlatformDeterministic: true,
  };
}

export function isWasmBuild(build: JoltBuild): build is JoltWasmBuild {
  return (joltWasmBuilds as readonly string[]).includes(build);
}

export function isExternalWasmBuild(build: JoltBuild): build is ExternalWasmBuild {
  return build === "wasm" || build === "wasm-multithread";
}

export function isEmbeddedWasmBuild(build: JoltBuild): build is EmbeddedWasmBuild {
  return isWasmBuild(build) && !isExternalWasmBuild(build);
}

export function wasmBinaryFileName(build: JoltBuild): string | undefined {
  if (build === "wasm") {
    return "jolt-physics.wasm.wasm";
  }
  if (build === "wasm-multithread") {
    return "jolt-physics.multithread.wasm.wasm";
  }
  return undefined;
}

export class JoltRuntime {
  readonly raw: JoltModule;
  readonly build: JoltBuild;
  readonly features: JoltRuntimeFeatures;

  constructor(raw: JoltModule, build: JoltBuild, features: Partial<JoltRuntimeFeatures> = {}) {
    this.raw = raw;
    this.build = build;
    this.features = { ...featuresForBuild(build), ...features };
  }

  scope(): NativeScope {
    return new NativeScope(this);
  }

  withScope<T>(callback: (scope: NativeScope) => T): T {
    const scope = this.scope();
    try {
      return callback(scope);
    } finally {
      scope.dispose();
    }
  }

  destroyRaw(value: unknown): void {
    if (value != null) {
      this.raw.destroy(value);
    }
  }

  freeMemory(): number | undefined {
    const raw = this.raw as JoltModule & {
      JoltInterface?: { prototype?: { sGetFreeMemory?: () => number } };
    };
    return raw.JoltInterface?.prototype?.sGetFreeMemory?.();
  }
}

export async function loadJolt(_options: LoadJoltOptions = {}): Promise<JoltRuntime> {
  throw new Error("This template loads its Jolt runtime from src/shared/physics.ts.");
}

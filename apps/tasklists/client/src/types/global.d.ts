interface Window {
  listsApp?: HTMLElement | null;
}

// Injected by esbuild at build time (see tools/build/esbuild.mjs). Falls back
// to "dev" when the placeholder is left untouched, e.g. in unit tests.
declare const __APP_VERSION__: string;

/**
 * Version reported for the client build. `__APP_VERSION__` is replaced by
 * esbuild at build time (see tools/build/esbuild.mjs) and `typeof` keeps the
 * module safe to import when the placeholder was not injected, such as in
 * unit tests, where it resolves to "dev".
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" && __APP_VERSION__.length > 0
    ? __APP_VERSION__
    : "dev";

/**
 * Fetches the running service version from the session-authenticated
 * `/version` endpoint. Returns null when the request fails or the payload is
 * unusable so callers can render an "unknown" state instead of throwing.
 */
export async function fetchServerVersion(baseUrl = ""): Promise<string | null> {
  try {
    const response = await fetch(`${baseUrl}/version`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { version?: unknown };
    return typeof payload?.version === "string" && payload.version.length > 0
      ? payload.version
      : null;
  } catch {
    return null;
  }
}

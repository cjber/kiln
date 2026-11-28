import style from "./web.css" with { type: "text" };
import page from "./web.html" with { type: "text" };
import script from "./web-client.js" with { type: "text" };

/**
 * The web client's device cookie. `__Host-` makes the browser refuse it unless it is Secure, host-only and on `/`;
 * HttpOnly keeps the token out of page script, and SameSite=Strict keeps other sites from sending it.
 */
const cookieName = "__Host-kiln";
const year = 365 * 24 * 60 * 60;

/** The device token a browser sent in its cookie, when it sent a well-formed one. */
export function cookieToken(request: Request): string | undefined {
  for (const part of request.headers.get("Cookie")?.split(";") ?? []) {
    const [name, value] = part.trim().split("=", 2);
    if (name === cookieName && value && /^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  }
  return undefined;
}

export function deviceCookie(token: string): string {
  return `${cookieName}=${token}; Path=/; Max-Age=${year}; HttpOnly; Secure; SameSite=Strict`;
}

export const clearedCookie = `${cookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

/** The client's own files; anything else on the origin is the API. */
const assets: Record<string, { body: string; type: string }> = {
  "/": { body: page, type: "text/html; charset=utf-8" },
  "/web.js": { body: script, type: "text/javascript; charset=utf-8" },
  "/web.css": { body: style, type: "text/css; charset=utf-8" },
};

/**
 * One of the client's files, with a policy that runs only the client's own script, connects only to this origin, and
 * cannot be framed, so a menu answer or Stop button can never be clicked through another page.
 */
export function webAsset(path: string): Response | undefined {
  const asset = assets[path];
  if (!asset) return undefined;
  return new Response(asset.body, {
    headers: {
      "Content-Type": asset.type,
      "Cache-Control": "no-cache",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

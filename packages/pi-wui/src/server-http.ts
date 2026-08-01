import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { WuiEndpoint } from "./server";
import { type AssetHtmlStager, isPathInside, MIME_TYPES } from "./server-assets";

const HTML_PREVIEW_SANDBOX = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WUI HTML sandbox</title>
  <style>
    html, body, #preview { width: 100%; height: 100%; margin: 0; border: 0; }
    body { overflow: hidden; background: white; }
    #preview { display: block; }
  </style>
</head>
<body>
  <iframe id="preview" title="HTML preview" sandbox=""></iframe>
  <script>
    window.addEventListener("message", function (event) {
      if (event.source !== parent || !event.data || event.data.type !== "pi-wui:html-preview") return;
      var preview = document.getElementById("preview");
      preview.setAttribute("sandbox", event.data.allowScripts === true ? "allow-scripts" : "");
      preview.title = typeof event.data.title === "string" ? event.data.title : "HTML preview";
      preview.srcdoc = typeof event.data.html === "string" ? event.data.html : "";
    });
  </script>
</body>
</html>`;

/** HTTP resource routing, host validation, and browser security policy. */
export class HttpSecurityRouter {
  constructor(
    private readonly staticDir: string,
    private readonly stager: AssetHtmlStager,
    private readonly endpoint: () => WuiEndpoint | undefined,
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setSecurityHeaders(response);
    if (!this.isAllowedHost(request.headers.host)) {
      response.writeHead(421, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Misdirected request");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      pathname = decodeURIComponent(pathname);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }

    if (pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : JSON.stringify({ ok: true }));
      return;
    }

    const assetMatch = pathname.match(/^\/_wui\/resource\/([A-Za-z0-9_-]+)\/([^/]+)$/);
    if (assetMatch) {
      const document = this.stager.assetDocuments.get(assetMatch[1]!);
      const status = document ? await tryStat(document.path) : undefined;
      if (!document || assetMatch[2] !== document.filename || !status?.isFile()) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Asset not found");
        return;
      }
      response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
      response.writeHead(200, {
        "Content-Type": document.contentType,
        "Content-Length": status.size,
        "Cache-Control": "private, max-age=31536000, immutable",
        ...(document.inline
          ? {}
          : { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}` }),
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(document.path)
        .on("error", () => response.destroy())
        .pipe(response);
      return;
    }

    if (pathname.startsWith("/_wui/")) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("WUI resource not found");
      return;
    }

    const stagedSandboxMatch = pathname.match(/^\/sandbox\/([A-Za-z0-9_-]+)(?:\/(.*))?$/);
    if (stagedSandboxMatch) {
      const document = this.stager.htmlDocuments.get(stagedSandboxMatch[1]!);
      const requestedRelativePath = stagedSandboxMatch[2];
      let requestedPath = document?.path;
      if (document?.rootPath && requestedRelativePath !== undefined) {
        requestedPath = resolve(document.rootPath, requestedRelativePath);
        if (!isPathInside(document.rootPath, requestedPath)) requestedPath = undefined;
      } else if (requestedRelativePath !== undefined) {
        requestedPath = undefined;
      }
      const status = requestedPath ? await tryStat(requestedPath) : undefined;
      if (!document || !requestedPath || !status?.isFile()) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Sandbox document not found");
        return;
      }
      response.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; script-src ${document.allowScripts ? "'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net/npm/alpinejs@3.15.12/dist/cdn.min.js" : "'none'"}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
      );
      response.setHeader("X-Frame-Options", "SAMEORIGIN");
      // The iframe deliberately has an opaque origin because it omits
      // allow-same-origin. Its relative images, styles, fonts, and scripts are
      // therefore cross-origin even though their URLs use this server. Relax
      // CORP only for this random, session-scoped sandbox bundle.
      response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      if (request.headers.origin === "null") {
        response.setHeader("Access-Control-Allow-Origin", "null");
        response.setHeader("Vary", "Origin");
      }
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[extname(requestedPath).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": status.size,
        "Cache-Control": "no-store",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(requestedPath)
        .on("error", () => response.destroy())
        .pipe(response);
      return;
    }

    if (pathname === "/sandbox") {
      // The shell must run one inline bridge script and permit inline HTML/CSS
      // in its nested srcdoc. It has no network access and can only be framed by
      // this server; the nested preview remains opaque-origin sandboxed.
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net/npm/alpinejs@3.15.12/dist/cdn.min.js; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      );
      response.setHeader("X-Frame-Options", "SAMEORIGIN");
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : HTML_PREVIEW_SANDBOX);
      return;
    }

    let filePath = pathname === "/" ? resolve(this.staticDir, "index.html") : resolve(this.staticDir, `.${pathname}`);
    if (!filePath.startsWith(`${this.staticDir}${sep}`) && filePath !== resolve(this.staticDir, "index.html")) {
      response.writeHead(404);
      response.end();
      return;
    }

    if (!(await tryStat(filePath))?.isFile()) filePath = resolve(this.staticDir, "index.html");

    const extension = extname(filePath).toLowerCase();
    const isHashedAsset = filePath.includes(`${sep}assets${sep}`);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] ?? "application/octet-stream",
      "Cache-Control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-store",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath)
      .on("error", () => response.destroy())
      .pipe(response);
  }

  private setSecurityHeaders(response: ServerResponse): void {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ws:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  }

  isAllowedHost(host: string | undefined): boolean {
    const endpoint = this.endpoint();
    if (!host || !endpoint) return false;
    const normalized = host.toLowerCase();
    const { port, hostname, tunnelHostname } = endpoint;
    return (
      normalized === `${hostname}:${port}` ||
      normalized === `127.0.0.1:${port}` ||
      normalized === `localhost:${port}` ||
      normalized === tunnelHostname
    );
  }

  isAllowedOrigin(origin: string | undefined): boolean {
    const endpoint = this.endpoint();
    if (!origin || !endpoint) return false;
    const { port, hostname, tunnelHostname } = endpoint;
    return new Set([
      `http://${hostname}:${port}`,
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      ...(tunnelHostname ? [`https://${tunnelHostname}`] : []),
    ]).has(origin.toLowerCase());
  }
}

async function tryStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

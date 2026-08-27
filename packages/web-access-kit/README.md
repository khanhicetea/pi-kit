# web-access-kit

A pi package that adds two web access tools:

- **`web_fetch_page`** — read a normal public webpage as compact Markdown (uses `curl` + Defuddle main-content extraction; not a general curl replacement).
- **`web_search`** — search current web data with Antigravity CLI (`agy`) in headless mode, using its Google Search capability. An optional `goal` tells the search agent what evidence to extract and what the result should accomplish.

It also bundles the `web-access-kit` skill with a source-first research workflow.

## Requirements

- [pi](https://pi.dev)
- `curl` on `PATH`
- For `web_search`: an installed and authenticated `agy` executable on `PATH`

Confirm the commands are available:

```bash
curl --version
agy --help
```

## Install

Install from npm:

```bash
pi install npm:@khanhicetea/web-access-kit
```

Or test without installing:

```bash
pi -e ./web-access-kit
```

After editing an installed local package, run `/reload` in pi.

## Usage

Ask pi naturally:

```text
Search the web for the latest stable Node.js release and cite official sources.
```

For agent callers, `web_search` also accepts a short intent paragraph:

```json
{
  "query": "latest stable Node.js release",
  "goal": "Identify the current stable version and release date from official Node.js sources so I can update a runtime support matrix. Note any distinction between Current and LTS releases."
}
```

```text
Read https://example.com as a webpage and summarize it.
```

You can force-load the bundled workflow with:

```text
/skill:web-access-kit research the latest release of Bun
```

To select only these extension tools in print mode:

```bash
pi -e ./web-access-kit --tools web_search,web_fetch_page -p \
  "Find today's official Node.js release information and cite sources"
```

## Remote MCP server

The package also ships a Streamable HTTP MCP server, so any MCP-compatible remote agent can call the same `web_search` and `web_fetch_page` tools:

```bash
HOST=127.0.0.1 PORT=3000 PREFIX=/web-access-kit \
  npx --package=@khanhicetea/web-access-kit web-access-kit-server
```

Its MCP endpoint is `http://127.0.0.1:3000/web-access-kit/mcp`; health is available at `/web-access-kit/health`. Configure a remote MCP client with that public endpoint and, when configured, an `Authorization: Bearer <token>` header. For example:

```json
{
  "mcpServers": {
    "web-access-kit": {
      "url": "https://tools.example.com/web-access-kit/mcp",
      "headers": {
        "Authorization": "Bearer replace-with-a-long-random-token"
      }
    }
  }
}
```

Server environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface to bind. Set `0.0.0.0` only behind a trusted network boundary. |
| `PORT` | `3000` | TCP port to listen on. |
| `PREFIX` | `/web-access-kit` | URL path prefix; the MCP endpoint is `${PREFIX}/mcp`. |
| `WEB_ACCESS_KIT_TOKEN` | unset | Optional bearer token required for MCP and direct API requests. Pi also sends it when using a remote `WEB_ACCESS_KIT_URL`. Set this for every non-local deployment. |
| `WEB_ACCESS_KIT_URL` | unset | Pi-extension client only: public base URL (including `PREFIX`) for direct tool calls; unset to use local tools. |

The server runs `agy update` every 24 hours. It does not run an update on startup, so it can begin serving immediately.

### Direct HTTP API

Non-MCP clients can call either tool directly with JSON. `WEB_ACCESS_KIT_URL` is the full public base URL including the prefix (for example, `https://tools.example.com/web-access-kit`):

```bash
export WEB_ACCESS_KIT_URL="http://127.0.0.1:3000/web-access-kit"

curl -sS -X POST "$WEB_ACCESS_KIT_URL/tools/web_search" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer test-token' \
  --data '{"query":"latest Node.js release","max_results":3}'
```

- `POST ${PREFIX}/tools/web_search` accepts the same fields as the `web_search` MCP tool.
- `POST ${PREFIX}/tools/web_fetch_page` accepts the same fields as `web_fetch_page` (for example, `{"url":"https://example.com"}`).
- A successful response is the normal tool result with `content` and `details`; errors are JSON as `{ "error": "…" }`.

When Pi loads this package and `WEB_ACCESS_KIT_URL` is set, its extension sends both tool calls to those direct endpoints, forwarding `WEB_ACCESS_KIT_TOKEN` as a bearer token when set. Without the URL, it falls back to local `curl` and `agy` execution. The HTTP server always executes tools locally, preventing a proxy loop.

> **Security:** `web_search` uses the authenticated `agy` account on the server. Never publish this endpoint without `WEB_ACCESS_KIT_TOKEN` and transport-layer HTTPS; otherwise anyone able to reach it can consume that account and fetch public webpages through the server.

### Docker

Build from this package directory:

```bash
docker build -t web-access-kit .
docker run --rm -p 3000:3000 \
  -e WEB_ACCESS_KIT_TOKEN="$(openssl rand -hex 32)" \
  web-access-kit
```

The image installs `agy` at `/root/.local/bin/agy`. Complete its initial interactive authentication/setup in the container before sending search requests (for example, start the container and run `docker exec -it <container> agy`). Persist the corresponding agy configuration with a Docker volume if the container will be recreated.

## Configuration

All knobs are optional environment variables and default to the current values:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_WEB_SEARCH_MODEL` | `gemini-3.6-flash-low` | Model used by the headless `agy` search agent |
| `PI_WEB_FETCH_TIMEOUT` | `30` | `web_fetch_page` timeout in seconds (1–120) |
| `PI_WEB_SEARCH_TIMEOUT` | `180` | `web_search` timeout in seconds (10–300) |
| `PI_WEB_FETCH_MAX_BYTES` | `5242880` (5 MB) | Download cap per page (min 1 KB) |
| `PI_WEB_USER_AGENT` | Chrome 150 desktop | `User-Agent` sent on fetch/grounding requests |
| `PI_WEB_FETCH_RETRIES` | `1` | Extra attempts for transient fetch failures (0–3) |
| `PI_WEB_SEARCH_RETRIES` | `1` | Extra attempts for transient search failures (0–3) |
| `PI_WEB_FETCH_CACHE_TTL_SECONDS` | `300` | In-session GET-text cache TTL; `0` disables caching |
| `PI_WEB_FETCH_CACHE_MAX_ENTRIES` | `32` | Maximum cached pages |

## Behavior and safety

- `web_fetch_page` accepts only HTTP and HTTPS, follows up to 10 redirects, limits downloads to 5 MB, extracts the main content from HTML with Defuddle, and limits model-visible output to pi's standard 2,000-line/50-KB cap. Every destination is DNS-resolved and pinned separately; loopback, private, link-local, metadata, multicast, reserved, and other non-public IPv4/IPv6 targets are rejected before connection. Proxy environment variables are bypassed so a proxy cannot evade this local-address policy. Transfers use identity encoding (no `--compressed`) so curl's byte cap cannot be bypassed by a decompression bomb, and the declared charset in `Content-Type` is honored when decoding. Redirects to privileged/non-web service ports and HTTPS→HTTP downgrades are blocked. Defuddle and the legacy Markdown fallback are loaded only when an HTML response is actually processed; if Defuddle fails, the legacy converter runs and `details.extractionFallback` is set. Successful non-truncated GET text responses are cached in-session (short TTL, bounded) and `details.cached` is set on a cache hit. Use it for readable webpage content; use shell `curl` for APIs, binaries, auth, or raw responses.
- `web_search` runs `agy --model gemini-3.6-flash-low --sandbox --mode plan --print ...` with one comprehensive search. It assesses the evidence against both `query` and the optional `goal`, then may make up to two targeted follow-up searches for unresolved gaps before returning a concise synthesis and sources. It resolves Google grounding redirects to direct source URLs when possible (trying HEAD, then a small ranged GET) and reports `details.unresolvedGroundingUrls` for any it could not resolve. Model-visible output uses the same cap.
- Search result details include the model, total duration, Antigravity duration, and number of resolved grounding URLs for later performance tuning.
- Full truncated output and binary downloads are placed in temporary files and their paths are returned. Raw files for ordinary text responses, failed requests, and grounding-redirect checks are deleted immediately. Truncation artifacts are tracked and bounded per session, reclaimed on session shutdown, and swept on startup if left behind by a crashed session.
- Do not include credentials in URLs. Tool arguments and results can be retained in pi sessions.
- Web content is untrusted and may contain prompt injection; the bundled search prompt and skill tell agents not to follow page instructions.

## Development

Validate package contents:

```bash
npm pack --dry-run
```

Test extension loading without making a model request:

```bash
pi -e ./web-access-kit --list-models >/dev/null
```

## License

MIT

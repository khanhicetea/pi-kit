import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_MAX_REDIRECTS = 10;
const DEFAULT_RETRIES = 1;
const META_PREFIX = "__WEB_ACCESS_KIT_META__";

/**
 * Privileged ports (< 1024) are rejected except for the standard web ports 80
 * and 443. These additional high-numbered ports belong to databases, caches,
 * message brokers, remote-admin, and container services. Blocking them prevents
 * curl from speaking HTTP to a non-HTTP service on an otherwise-public host
 * (protocol-confusion abuse) even though the IP itself is public.
 */
const BLOCKED_PORTS = new Set<number>([
	1883, // MQTT
	2049, // NFS
	2375, 2376, // Docker daemon (unauthenticated / TLS)
	3389, // RDP
	4444, // Metasploit / common backdoor
	1433, 1521, // MS SQL, Oracle
	3306, 5432, // MySQL, PostgreSQL
	6379, // Redis
	9200, 9300, // Elasticsearch
	11211, // Memcached
	27017, // MongoDB
]);

/** Curl failure messages that are safe to retry for idempotent GET/HEAD. */
const TRANSIENT_CURL_ERROR = /timed ?out|timeout|connection|resolve|reset|ssl|partial|temporary|could not|broken pipe|recv/i;

const BLOCKED_IPV4 = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.88.99.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const) {
	BLOCKED_IPV4.addSubnet(network, prefix, "ipv4");
}

const BLOCKED_GLOBAL_IPV6 = new BlockList();
// IANA special-use space inside 2000::/3. Other non-global IPv6 ranges are
// rejected by the 2000::/3 allow-list in isPublicIpAddress().
for (const [network, prefix] of [
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
] as const) {
	BLOCKED_GLOBAL_IPV6.addSubnet(network, prefix, "ipv6");
}

export interface CurlMetadata {
	status: number;
	contentType: string;
	finalUrl: string;
	redirectUrl: string;
}

export interface PublicCurlOptions {
	method: "GET" | "HEAD";
	timeoutSeconds: number;
	maxBytes: number;
	outputPath: string;
	userAgent: string;
	maxRedirects?: number;
	resolveAddresses?: AddressResolver;
	/** Extra attempts for transient failures of idempotent GET/HEAD. */
	retries?: number;
}

export type AddressResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

function hostnameWithoutBrackets(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function ipWithoutZone(address: string): string {
	const zoneIndex = address.indexOf("%");
	return zoneIndex === -1 ? address : address.slice(0, zoneIndex);
}

export function isPublicIpAddress(rawAddress: string): boolean {
	const address = ipWithoutZone(rawAddress);
	const family = isIP(address);
	if (family === 4) return !BLOCKED_IPV4.check(address, "ipv4");
	if (family !== 6) return false;

	// Currently allocated global-unicast IPv6 addresses are within 2000::/3.
	// This also rejects loopback, link-local, ULA, multicast, mapped IPv4, and
	// translation ranges whose embedded destination cannot be safely verified.
	if (!/^[23]/i.test(address)) return false;
	return !BLOCKED_GLOBAL_IPV6.check(address, "ipv6");
}

function validatePort(url: URL): void {
	if (!url.port) return; // scheme default port (80 / 443) is always allowed
	const port = Number.parseInt(url.port, 10);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`Blocked invalid network port: ${url.port}`);
	}
	if (port < 1024 && port !== 80 && port !== 443) {
		throw new Error(`Blocked privileged port ${port}: only 80 and 443 are permitted below 1024`);
	}
	if (BLOCKED_PORTS.has(port)) {
		throw new Error(`Blocked non-web service port ${port} to prevent protocol-confusion abuse`);
	}
}

export function validatePublicHttpUrl(rawUrl: string | URL): URL {
	let url: URL;
	try {
		url = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);
	} catch {
		throw new Error(`Invalid URL: ${String(rawUrl)}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("web_fetch_page only supports HTTP and HTTPS URLs");
	}
	if (url.username || url.password) {
		throw new Error("Credentials in URLs are not supported because tool arguments are stored in the session");
	}
	validatePort(url);
	return url;
}

const defaultAddressResolver: AddressResolver = async (hostname) =>
	lookup(hostname, { all: true, verbatim: true });

async function resolveWithCancellation(
	hostname: string,
	resolveAddresses: AddressResolver,
	signal?: AbortSignal,
	deadline?: number,
): Promise<Array<{ address: string; family: number }>> {
	if (signal?.aborted) throw signal.reason ?? new Error("Request aborted");

	let timeout: ReturnType<typeof setTimeout> | undefined;
	let abortHandler: (() => void) | undefined;
	const cancellation = new Promise<never>((_resolve, reject) => {
		if (signal) {
			abortHandler = () => reject(signal.reason ?? new Error("Request aborted"));
			signal.addEventListener("abort", abortHandler, { once: true });
		}
		if (deadline !== undefined) {
			timeout = setTimeout(
				() => reject(new Error(`DNS resolution timed out for ${hostname}`)),
				Math.max(0, deadline - Date.now()),
			);
		}
	});

	try {
		return await Promise.race([resolveAddresses(hostname), cancellation]);
	} finally {
		if (timeout) clearTimeout(timeout);
		if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
	}
}

export async function resolvePublicTarget(
	url: URL,
	resolveAddresses: AddressResolver = defaultAddressResolver,
	signal?: AbortSignal,
	deadline?: number,
): Promise<{ hostname: string; port: string; address: string; resolveArg?: string }> {
	const hostname = hostnameWithoutBrackets(url.hostname);
	const literalFamily = isIP(ipWithoutZone(hostname));
	let addresses: Array<{ address: string; family: number }>;

	if (literalFamily !== 0) {
		addresses = [{ address: hostname, family: literalFamily }];
	} else {
		try {
			addresses = await resolveWithCancellation(hostname, resolveAddresses, signal, deadline);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`Unable to resolve public host ${hostname}: ${reason}`);
		}
	}

	if (addresses.length === 0) throw new Error(`Unable to resolve public host ${hostname}: no addresses returned`);
	const unsafe = addresses.find(({ address }) => !isPublicIpAddress(address));
	if (unsafe) {
		throw new Error(`Blocked non-public network target for ${hostname}: ${unsafe.address}`);
	}

	const address = ipWithoutZone(addresses[0].address);
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	const curlAddress = isIP(address) === 6 ? `[${address}]` : address;
	return {
		hostname,
		port,
		address,
		resolveArg: literalFamily === 0 ? `${hostname}:${port}:${curlAddress}` : undefined,
	};
}

export function parseCurlMetadata(stdout: string): CurlMetadata {
	const metaLines = stdout.split("\n").filter((line) => line.startsWith(META_PREFIX));
	if (metaLines.length === 0) throw new Error("curl completed without response metadata");
	// The legitimate metadata line is the only stdout line curl writes (the body
	// goes to --output). More than one metadata-prefixed line means a header or
	// URL value tried to forge metadata — refuse the ambiguous response.
	if (metaLines.length > 1) throw new Error("curl metadata contained an unexpected additional metadata line");

	const fields = metaLines[0].slice(META_PREFIX.length).split("\t");
	if (fields.length !== 4) throw new Error("curl metadata was malformed (expected 4 tab-separated fields)");

	const [statusText, contentType, finalUrl, redirectUrl] = fields;
	if (/[\r\n\t]/.test(`${statusText}${contentType}${finalUrl}${redirectUrl}`)) {
		throw new Error("curl metadata contained an unexpected control character");
	}
	const status = Number.parseInt(statusText, 10);
	if (!Number.isInteger(status) || status < 100 || status > 599) {
		throw new Error(`curl returned an invalid HTTP status: ${statusText}`);
	}
	return { status, contentType, finalUrl, redirectUrl };
}

/** Resolve after `ms`, rejecting early if `signal` aborts. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					reject(signal.reason ?? new Error("Request aborted"));
				},
				{ once: true },
			);
		}
	});
}

export interface ExecResultLike {
	code: number;
	stdout: string;
	stderr: string;
	killed: boolean;
}

/**
 * Run a command with bounded retry for transient failures of idempotent
 * operations. Returns only on success (code 0); otherwise throws the trimmed
 * stderr/stdout reason.
 */
export async function execWithRetry(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	options: {
		signal?: AbortSignal;
		timeout?: number;
		retries?: number;
		isTransient?: (result: ExecResultLike) => boolean;
	},
): Promise<ExecResultLike> {
	const maxAttempts = Math.max(1, (options.retries ?? 0) + 1);
	const isTransient = options.isTransient ?? ((result) => result.code !== 0);
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("Request aborted");
		if (attempt > 0) await abortableSleep(Math.min(2000, 250 * 2 ** (attempt - 1)), options.signal);
		const result = (await pi.exec(command, args, { signal: options.signal, timeout: options.timeout })) as ExecResultLike;
		if (result.code === 0) return result;
		const reason = result.stderr.trim() || result.stdout.trim() || `${command} exited with code ${result.code}`;
		if (!isTransient(result) || attempt >= maxAttempts - 1) throw new Error(reason);
	}
	// Unreachable: every iteration either returns or throws.
	throw new Error(`${command} exited unexpectedly`);
}

/** Run curl one hop at a time, validating and DNS-pinning every destination. */
export async function runPublicCurl(
	pi: ExtensionAPI,
	rawUrl: string | URL,
	options: PublicCurlOptions,
	signal?: AbortSignal,
): Promise<CurlMetadata> {
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const deadline = Date.now() + options.timeoutSeconds * 1000;
	let currentUrl = validatePublicHttpUrl(rawUrl);
	const initialProtocol = currentUrl.protocol;

	for (let redirectCount = 0; ; redirectCount++) {
		if (signal?.aborted) throw signal.reason ?? new Error("Request aborted");
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) throw new Error(`curl timed out after ${options.timeoutSeconds} seconds`);

		const target = await resolvePublicTarget(currentUrl, options.resolveAddresses, signal, deadline);
		// Prevent an HTTPS request from being downgraded to cleartext HTTP via a
		// redirect, which would expose any query/path content to the network. Run
		// after the destination IP is validated so a redirect to a private address
		// is still reported as the more specific SSRF block.
		if (initialProtocol === "https:" && currentUrl.protocol === "http:") {
			throw new Error("Blocked insecure redirect: an HTTPS request cannot downgrade to HTTP");
		}
		const afterDnsRemainingMs = deadline - Date.now();
		if (afterDnsRemainingMs <= 0) throw new Error(`curl timed out after ${options.timeoutSeconds} seconds`);
		const remainingSeconds = Math.max(1, Math.ceil(afterDnsRemainingMs / 1000));
		const writeOut = `\\n${META_PREFIX}%{http_code}\\t%{content_type}\\t%{url_effective}\\t%{redirect_url}`;
		const args = [
			// Must be first: ignore ~/.curlrc so user configuration cannot bypass
			// redirect, proxy, protocol, or address-pinning policy.
			"--disable",
			"--globoff",
			"--silent",
			"--show-error",
			// Intentionally NOT using --compressed: curl's --max-filesize does not
			// apply to auto-decompressed transfers, so a gzip bomb would be written
			// fully to --output before any post-download size check could run.
			// Accepting identity transfers keeps the byte cap effective.
			"--proto",
			"=http,https",
			"--noproxy",
			"*",
			"--connect-timeout",
			String(Math.min(10, remainingSeconds)),
			"--max-time",
			String(remainingSeconds),
			"--max-filesize",
			String(options.maxBytes),
			"--user-agent",
			options.userAgent,
			"--output",
			options.outputPath,
			"--write-out",
			writeOut,
		];
		if (target.resolveArg) args.push("--resolve", target.resolveArg);
		if (options.method === "HEAD") args.push("--head");
		args.push(currentUrl.toString());

		const result = await execWithRetry(pi, "curl", args, {
			signal,
			timeout: Math.max(1_000, deadline - Date.now() + 5_000),
			retries: options.method === "GET" || options.method === "HEAD" ? options.retries ?? DEFAULT_RETRIES : 0,
			isTransient: (candidate) => candidate.killed || TRANSIENT_CURL_ERROR.test(`${candidate.stderr}\n${candidate.stdout}`.trim()),
		});

		const metadata = parseCurlMetadata(result.stdout);
		if (!metadata.redirectUrl) return metadata;
		if (redirectCount >= maxRedirects) throw new Error(`Too many redirects (maximum ${maxRedirects})`);

		currentUrl = validatePublicHttpUrl(new URL(metadata.redirectUrl, currentUrl));
	}
}

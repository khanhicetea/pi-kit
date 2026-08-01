import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_MAX_REDIRECTS = 10;
const META_PREFIX = "__WEB_ACCESS_KIT_META__";

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
	const line = stdout
		.split("\n")
		.reverse()
		.find((candidate) => candidate.startsWith(META_PREFIX));
	if (!line) throw new Error("curl completed without response metadata");

	const [statusText, contentType = "", finalUrl = "", redirectUrl = ""] = line
		.slice(META_PREFIX.length)
		.split("\t");
	return {
		status: Number.parseInt(statusText, 10) || 0,
		contentType,
		finalUrl,
		redirectUrl,
	};
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

	for (let redirectCount = 0; ; redirectCount++) {
		if (signal?.aborted) throw signal.reason ?? new Error("Request aborted");
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) throw new Error(`curl timed out after ${options.timeoutSeconds} seconds`);

		const target = await resolvePublicTarget(currentUrl, options.resolveAddresses, signal, deadline);
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
			"--compressed",
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

		const result = await pi.exec("curl", args, {
			signal,
			timeout: Math.max(1_000, deadline - Date.now() + 5_000),
		});
		if (result.code !== 0) {
			const reason = result.stderr.trim() || `curl exited with code ${result.code}`;
			throw new Error(reason);
		}

		const metadata = parseCurlMetadata(result.stdout);
		if (!metadata.redirectUrl) return metadata;
		if (redirectCount >= maxRedirects) throw new Error(`Too many redirects (maximum ${maxRedirects})`);

		currentUrl = validatePublicHttpUrl(new URL(metadata.redirectUrl, currentUrl));
	}
}

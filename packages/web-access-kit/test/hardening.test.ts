import assert from "node:assert/strict";
import { test } from "node:test";
import { Buffer } from "node:buffer";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	execWithRetry,
	parseCurlMetadata,
	runPublicCurl,
	validatePublicHttpUrl,
} from "../extensions/public-http.ts";
import { decodeBody } from "../extensions/web-access-kit.ts";

const fakePi = (handler: (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) =>
	({ exec: (command: string, args: string[]) => handler(command, args) } as unknown as ExtensionAPI);

test("port validation allows standard and high web ports", () => {
	for (const url of [
		"https://example.com", // default 443
		"http://example.com", // default 80
		"https://example.com:443",
		"http://example.com:80",
		"https://example.com:8080",
		"http://example.com:8443",
		"http://localhost:3000",
		"https://example.com:8888",
	]) {
		assert.doesNotThrow(() => validatePublicHttpUrl(url), url);
	}
});

test("port validation blocks privileged and non-web service ports", () => {
	for (const [url, pattern] of [
		["https://example.com:22", /privileged port 22/],
		["http://example.com:25", /privileged port 25/],
		["http://example.com:53", /privileged port 53/],
		["http://example.com:1023", /privileged port 1023/],
		["http://example.com:6379", /non-web service port 6379/],
		["https://example.com:3306", /non-web service port 3306/],
		["http://example.com:5432", /non-web service port 5432/],
		["http://example.com:9200", /non-web service port 9200/],
		["http://example.com:27017", /non-web service port 27017/],
		["http://example.com:11211", /non-web service port 11211/],
		["http://example.com:2375", /non-web service port 2375/],
	] as const) {
		assert.throws(() => validatePublicHttpUrl(url), pattern, url);
	}
});

test("an HTTPS to HTTP redirect downgrade is blocked", async () => {
	const pi = fakePi(async () => ({
		code: 0,
		stdout: "__WEB_ACCESS_KIT_META__302\ttext/html\thttps://example.com/\thttp://example.com/insecure",
		stderr: "",
	}));
	await assert.rejects(
		runPublicCurl(pi, "https://example.com/", {
			method: "GET", timeoutSeconds: 30, maxBytes: 1024, outputPath: "/tmp/unused", userAgent: "t",
			resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
		}),
		/insecure redirect.*cannot downgrade to HTTP/,
	);
});

test("an HTTP to HTTPS redirect upgrade is allowed", async () => {
	let calls = 0;
	const pi = fakePi(async () => {
		calls++;
		return calls === 1
			? { code: 0, stdout: "__WEB_ACCESS_KIT_META__301\ttext/html\thttp://example.com/\thttps://example.com/secure", stderr: "" }
			: { code: 0, stdout: "__WEB_ACCESS_KIT_META__200\ttext/html\thttps://example.com/secure\t", stderr: "" };
	});
	const result = await runPublicCurl(pi, "http://example.com/", {
		method: "GET", timeoutSeconds: 30, maxBytes: 1024, outputPath: "/tmp/unused", userAgent: "t",
		resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
	});
	assert.equal(result.finalUrl, "https://example.com/secure");
	assert.equal(calls, 2);
});

test("parseCurlMetadata parses a well-formed metadata line", () => {
	const meta = parseCurlMetadata("body noise\n__WEB_ACCESS_KIT_META__200\ttext/html; charset=utf-8\thttps://x/\t");
	assert.deepEqual(meta, { status: 200, contentType: "text/html; charset=utf-8", finalUrl: "https://x/", redirectUrl: "" });
});

test("parseCurlMetadata rejects a forged additional metadata line", () => {
	assert.throws(
		() => parseCurlMetadata("__WEB_ACCESS_KIT_META__200\ttext/html\thttps://x/\t\n__WEB_ACCESS_KIT_META__200\ttext/html\thttps://evil/\t"),
		/unexpected additional metadata line/,
	);
});

test("parseCurlMetadata rejects malformed fields and invalid status", () => {
	assert.throws(() => parseCurlMetadata("__WEB_ACCESS_KIT_META__200\ttext/html\thttps://x/"), /malformed/); // 3 fields
	assert.throws(() => parseCurlMetadata("__WEB_ACCESS_KIT_META__999\ttext/html\thttps://x/\t"), /invalid HTTP status/);
	assert.throws(() => parseCurlMetadata("__WEB_ACCESS_KIT_META__abc\ttext/html\thttps://x/\t"), /invalid HTTP status/);
	assert.throws(() => parseCurlMetadata("no metadata here"), /without response metadata/);
});

test("execWithRetry returns on first success", async () => {
	let calls = 0;
	const pi = fakePi(async () => { calls++; return { code: 0, stdout: "ok", stderr: "", killed: false }; });
	const result = await execWithRetry(pi, "x", [], { retries: 2 });
	assert.equal(result.code, 0);
	assert.equal(calls, 1);
});

test("execWithRetry retries a transient failure then succeeds", async () => {
	let calls = 0;
	const pi = fakePi(async () => {
		calls++;
		return calls < 3
			? { code: 28, stdout: "", stderr: "operation timed out", killed: true }
			: { code: 0, stdout: "ok", stderr: "", killed: false };
	});
	const result = await execWithRetry(pi, "curl", [], { retries: 3, isTransient: (r) => r.killed || /timed out/.test(r.stderr) });
	assert.equal(result.code, 0);
	assert.equal(calls, 3);
});

test("execWithRetry does not retry a non-transient failure", async () => {
	let calls = 0;
	const pi = fakePi(async () => { calls++; return { code: 3, stdout: "", stderr: "URL malformed", killed: false }; });
	await assert.rejects(execWithRetry(pi, "curl", [], { retries: 3, isTransient: () => false }), /URL malformed/);
	assert.equal(calls, 1);
});

test("execWithRetry throws after exhausting retries", async () => {
	let calls = 0;
	const pi = fakePi(async () => { calls++; return { code: 7, stdout: "", stderr: "connection refused", killed: false }; });
	await assert.rejects(
		execWithRetry(pi, "curl", [], { retries: 1, isTransient: (r) => /connection/.test(r.stderr) }),
		/connection refused/,
	);
	assert.equal(calls, 2);
});

test("decodeBody honors a Content-Type charset", () => {
	// "é" in ISO-8859-1 / windows-1252 is 0xE9.
	const latin1 = Buffer.from([0xe9]);
	assert.equal(decodeBody(latin1, "text/html; charset=ISO-8859-1"), "é");
	assert.equal(decodeBody(latin1, "text/html; charset=windows-1252"), "é");
});

test("decodeBody defaults to UTF-8 and tolerates an unknown charset", () => {
	const utf8 = Buffer.from("héllo", "utf8");
	assert.equal(decodeBody(utf8, "text/plain"), "héllo");
	// Unknown label falls back to utf8 instead of throwing.
	assert.equal(decodeBody(utf8, "text/plain; charset=not-a-real-charset"), "héllo");
});

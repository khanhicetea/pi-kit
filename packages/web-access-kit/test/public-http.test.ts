import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isPublicIpAddress,
	resolvePublicTarget,
	runPublicCurl,
	validatePublicHttpUrl,
} from "../extensions/public-http.ts";

const publicAddresses = ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"];
const blockedAddresses = [
	"0.0.0.0",
	"10.0.0.1",
	"100.64.0.1",
	"127.0.0.1",
	"169.254.169.254",
	"172.16.0.1",
	"192.168.0.1",
	"198.18.0.1",
	"224.0.0.1",
	"::1",
	"::ffff:8.8.8.8",
	"fc00::1",
	"fe80::1",
	"2001:db8::1",
	"2002:0808:0808::",
	"ff02::1",
];

test("IP policy allows global addresses and blocks non-public ranges", () => {
	for (const address of publicAddresses) assert.equal(isPublicIpAddress(address), true, address);
	for (const address of blockedAddresses) assert.equal(isPublicIpAddress(address), false, address);
});

test("URL validation rejects credentials and non-HTTP protocols", () => {
	assert.throws(() => validatePublicHttpUrl("file:///etc/passwd"), /HTTP and HTTPS/);
	assert.throws(() => validatePublicHttpUrl("https://user:secret@example.com"), /Credentials/);
});

test("resolution rejects a hostname if any answer is non-public", async () => {
	await assert.rejects(
		resolvePublicTarget(new URL("https://example.com"), async () => [
			{ address: "93.184.216.34", family: 4 },
			{ address: "127.0.0.1", family: 4 },
		]),
		/Blocked non-public network target/,
	);
});

test("curl requests are DNS-pinned and redirects are validated hop by hop", async () => {
	const calls: string[][] = [];
	const pi = {
		async exec(_command: string, args: string[]) {
			calls.push(args);
			const requestUrl = args.at(-1);
			if (requestUrl === "https://first.example/") {
				return {
					code: 0,
					stdout: "__WEB_ACCESS_KIT_META__302\ttext/html\thttps://first.example/\thttps://second.example/page",
					stderr: "",
				};
			}
			return {
				code: 0,
				stdout: "__WEB_ACCESS_KIT_META__200\ttext/plain\thttps://second.example/page\t",
				stderr: "",
			};
		},
	} as unknown as ExtensionAPI;

	const result = await runPublicCurl(
		pi,
		"https://first.example/",
		{
			method: "GET",
			timeoutSeconds: 30,
			maxBytes: 1024,
			outputPath: "/tmp/unused-test-output",
			userAgent: "test",
			resolveAddresses: async (hostname) => [
				{ address: hostname === "first.example" ? "93.184.216.34" : "1.1.1.1", family: 4 },
			],
		},
		new AbortController().signal,
	);

	assert.equal(result.finalUrl, "https://second.example/page");
	assert.equal(calls.length, 2);
	assert.equal(calls[0].includes("--location"), false);
	assert.deepEqual(calls[0].slice(calls[0].indexOf("--resolve"), calls[0].indexOf("--resolve") + 2), [
		"--resolve",
		"first.example:443:93.184.216.34",
	]);
	assert.deepEqual(calls[1].slice(calls[1].indexOf("--resolve"), calls[1].indexOf("--resolve") + 2), [
		"--resolve",
		"second.example:443:1.1.1.1",
	]);
});

test("DNS resolution stops waiting when the request is aborted", async () => {
	let curlCalls = 0;
	const pi = {
		async exec() {
			curlCalls++;
			return { code: 0, stdout: "", stderr: "" };
		},
	} as unknown as ExtensionAPI;
	const controller = new AbortController();
	const pending = runPublicCurl(
		pi,
		"https://example.com/",
		{
			method: "GET",
			timeoutSeconds: 30,
			maxBytes: 1024,
			outputPath: "/tmp/unused-test-output",
			userAgent: "test",
			resolveAddresses: async () => new Promise(() => undefined),
		},
		controller.signal,
	);
	controller.abort(new Error("cancelled"));
	await assert.rejects(pending, /cancelled/);
	assert.equal(curlCalls, 0);
});

test("a redirect to a private address is blocked before the second request", async () => {
	let calls = 0;
	const pi = {
		async exec() {
			calls++;
			return {
				code: 0,
				stdout: "__WEB_ACCESS_KIT_META__302\ttext/html\thttps://example.com/\thttp://127.0.0.1/admin",
				stderr: "",
			};
		},
	} as unknown as ExtensionAPI;

	await assert.rejects(
		runPublicCurl(
			pi,
			"https://example.com/",
			{
				method: "GET",
				timeoutSeconds: 30,
				maxBytes: 1024,
				outputPath: "/tmp/unused-test-output",
				userAgent: "test",
				resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
			},
			new AbortController().signal,
		),
		/Blocked non-public network target/,
	);
	assert.equal(calls, 1);
});

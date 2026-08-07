import assert from "node:assert/strict";
import { test } from "node:test";
import { stripBase64DataImages } from "../extensions/web-access-kit.ts";

test("base64 data images are removed from final Markdown", () => {
	const markdown = [
		"Before ![diagram](data:image/png;base64,iVBORw0KGgoAAA==) after",
		"<img alt=\"pixel\" src=\"data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==\">",
		"Raw data:image/svg+xml;charset=utf-8;base64,PHN2Zz48L3N2Zz4= URI",
	].join("\n");

	const cleaned = stripBase64DataImages(markdown);
	assert.equal(cleaned, "Before diagram after\n\nRaw  URI");
	assert.doesNotMatch(cleaned, /data:image/i);
	assert.doesNotMatch(cleaned, /iVBOR|R0lGOD|PHN2Z/);
});

test("ordinary remote images are preserved", () => {
	const markdown = "![diagram](https://example.com/diagram.png)";
	assert.equal(stripBase64DataImages(markdown), markdown);
});

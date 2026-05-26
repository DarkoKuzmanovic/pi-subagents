import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";
import { pad } from "../../src/tui/render-helpers.ts";

test("pad extends string to target width", () => {
	const padded = pad("hello", 10);
	assert.equal(visibleWidth(padded), 10);
});

test("pad is no-op when string already at target width", () => {
	const padded = pad("hello", 5);
	assert.equal(visibleWidth(padded), 5);
});

test("pad handles zero-width ANSI strings", () => {
	const styled = "\x1b[31mhi\x1b[39m";
	const padded = pad(styled, 5);
	assert.equal(visibleWidth(padded), 5);
});

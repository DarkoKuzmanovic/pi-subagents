/**
 * Unit tests for inline read configuration (Optimization 5).
 */
import * as assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { getInlineReadMaxBytes, setInlineReadMaxBytes, buildChainInstructions } from "../../src/shared/settings.ts";

describe("inlineReadMaxBytes config", () => {
	const DEFAULT = 200 * 1024;

	beforeEach(() => {
		setInlineReadMaxBytes(undefined); // reset to default
	});

	it("returns default value when not set", () => {
		assert.equal(getInlineReadMaxBytes(), DEFAULT);
	});

	it("sets a valid value within range", () => {
		setInlineReadMaxBytes(4096);
		assert.equal(getInlineReadMaxBytes(), 4096);
	});

	it("clamps values below minimum to 1024", () => {
		setInlineReadMaxBytes(500);
		assert.equal(getInlineReadMaxBytes(), 1024);
	});

	it("clamps values above maximum to 8MB", () => {
		setInlineReadMaxBytes(20 * 1024 * 1024);
		assert.equal(getInlineReadMaxBytes(), 8 * 1024 * 1024);
	});

	it("rejects NaN and falls back to default", () => {
		setInlineReadMaxBytes(NaN);
		assert.equal(getInlineReadMaxBytes(), DEFAULT);
	});

	it("rejects Infinity and falls back to default", () => {
		setInlineReadMaxBytes(Infinity);
		assert.equal(getInlineReadMaxBytes(), DEFAULT);
	});

	it("resets to default when called with undefined", () => {
		setInlineReadMaxBytes(4096);
		setInlineReadMaxBytes(undefined);
		assert.equal(getInlineReadMaxBytes(), DEFAULT);
	});

	it("rejects string value and falls back to default", () => {
		setInlineReadMaxBytes("hello" as unknown as number);
		assert.equal(getInlineReadMaxBytes(), DEFAULT);
	});
});

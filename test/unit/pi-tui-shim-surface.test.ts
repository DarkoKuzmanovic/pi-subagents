import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	Box,
	Container,
	Key,
	Markdown,
	SelectList,
	SettingsList,
	Spacer,
	Text,
	fuzzyFilter,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/**
 * Surface coverage for the pi-tui test shim.
 *
 * The shim is what every UI test in this repo actually runs against, so a method that is
 * declared in shims/pi-tui.d.ts but missing (or a silent no-op) in ts-loader.mjs makes the
 * suite pass while the real component would behave differently. `SelectList.setFilter`
 * shipped declared-but-missing; these tests exercise each declared member behaviourally so
 * the next such gap fails here instead of hiding.
 */

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";
const CTRL_C = "\x03";

const selectItems = [
	{ value: "alpha", label: "Alpha", description: "first" },
	{ value: "alpine", label: "Alpine", description: "second" },
	{ value: "beta", label: "Beta", description: "third" },
];

describe("pi-tui shim surface", () => {
	it("renders the primitive components", () => {
		const box = new Box({});
		box.addChild(new Text("boxed"));
		assert.deepEqual(box.render(40), ["boxed"]);

		const container = new Container();
		container.addChild(new Text("one"));
		container.addChild(new Markdown("two"));
		assert.deepEqual(container.render(40), ["one", "two"]);
		container.invalidate();
		container.clear();
		assert.equal(container.children.length, 0);
		assert.deepEqual(container.render(40), []);

		assert.deepEqual(new Spacer(2).render(), ["", ""]);
		assert.deepEqual(new Text("plain").render(40), ["plain"]);
		assert.equal(typeof Key, "object");
	});

	it("exposes working text utilities", () => {
		assert.equal(visibleWidth("abc"), 3);
		assert.equal(truncateToWidth("abcdef", 3, ""), "abc");
		// Known divergence, asserted so it stays visible: the shim chunks by width, while real
		// pi-tui wraps on word boundaries. Render assertions across the suite depend on this
		// chunking, so it is documented rather than silently "fixed".
		assert.deepEqual(wrapTextWithAnsi("aaa bbb", 3), ["aaa", " bb", "b"]);
		assert.deepEqual(
			fuzzyFilter([{ name: "alpha" }, { name: "beta" }], "alp", (item) => item.name),
			[{ name: "alpha" }],
		);
	});

	it("filters SelectList by value prefix and resets selection", () => {
		const list = new SelectList(selectItems, 5, {});
		list.setSelectedIndex(2);
		assert.equal(list.getSelectedItem()?.value, "beta");

		// Real component semantics: prefix match on `value`, selection reset to 0, no callback.
		let notified = 0;
		list.onSelectionChange = () => {
			notified += 1;
		};
		list.setFilter("alp");
		assert.equal(notified, 0);
		assert.equal(list.getSelectedItem()?.value, "alpha");
		assert.deepEqual(list.render(60).length, 2);

		// Navigation, clamping and getSelectedItem all follow the filtered list, not the full one.
		list.handleInput(DOWN);
		assert.equal(list.getSelectedItem()?.value, "alpine");
		list.setSelectedIndex(99);
		assert.equal(list.getSelectedItem()?.value, "alpine");

		list.setFilter("");
		assert.equal(list.render(60).length, 3);
		assert.equal(list.getSelectedItem()?.value, "alpha");
	});

	it("drives SelectList callbacks from real key sequences", () => {
		const list = new SelectList(selectItems, 5, {});
		const seen: string[] = [];
		list.onSelectionChange = (item) => seen.push(`change:${item.value}`);
		list.onSelect = (item) => seen.push(`select:${item.value}`);
		list.onCancel = () => seen.push("cancel");

		list.handleInput(DOWN);
		list.handleInput(UP);
		list.handleInput(ENTER);
		list.handleInput(ESCAPE);
		list.handleInput(CTRL_C);
		list.invalidate();

		assert.deepEqual(seen, ["change:alpine", "change:alpha", "select:alpha", "cancel", "cancel"]);
	});

	it("keeps SelectList selection unreadable rather than wrong when nothing matches", () => {
		// Parity note: the real component does not guard an empty filtered list either, so Up
		// leaves selectedIndex out of range. getSelectedItem() must still report null.
		const list = new SelectList(selectItems, 5, {});
		list.setFilter("zzz");
		assert.deepEqual(list.render(60), []);
		assert.equal(list.getSelectedItem(), null);
		list.handleInput(UP);
		assert.equal(list.getSelectedItem(), null);
	});

	it("updates SettingsList values in place and cycles on enter", () => {
		const changes: Array<[string, string]> = [];
		const items = [
			{ id: "mode", label: "Mode", currentValue: "fast", values: ["fast", "slow"] },
			{ id: "depth", label: "Depth", currentValue: "1", values: ["1", "2"] },
		];
		const list = new SettingsList(
			items,
			5,
			{},
			(id, newValue) => changes.push([id, newValue]),
			() => changes.push(["closed", ""]),
			{ enableSearch: true },
		);

		// updateValue is public on the real component and must mutate the live item.
		list.updateValue("depth", "2");
		assert.equal(items[1]?.currentValue, "2");
		list.updateValue("missing", "ignored");
		assert.equal(changes.length, 0);

		assert.equal(list.render(60).length, 2);
		list.handleInput(ENTER);
		assert.deepEqual(changes, [["mode", "slow"]]);
		assert.equal(items[0]?.currentValue, "slow");

		list.handleInput(DOWN);
		list.handleInput(ENTER);
		assert.deepEqual(changes[1], ["depth", "1"]);

		list.handleInput(ESCAPE);
		assert.deepEqual(changes.at(-1), ["closed", ""]);
		list.invalidate();
	});

	it("matches the key sequences the shim components rely on", () => {
		assert.equal(matchesKey(UP, "up"), true);
		assert.equal(matchesKey(DOWN, "down"), true);
		assert.equal(matchesKey(ENTER, "enter"), true);
		assert.equal(matchesKey(ESCAPE, "escape", "ctrl+c"), true);
		assert.equal(matchesKey(CTRL_C, "escape", "ctrl+c"), true);
		assert.equal(matchesKey("x", "up", "down", "enter"), false);
	});
});

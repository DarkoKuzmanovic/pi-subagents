import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	dynamicOmChildKey,
	staticParallelOmChildKey,
	staticSequentialOmChildKey,
} from "../../src/runs/shared/om-logical-keys.ts";

describe("om-logical-keys", () => {
	it("formats static sequential keys as root/{stepIndex}/sequential/0", () => {
		assert.equal(staticSequentialOmChildKey(0), "root/0/sequential/0");
		assert.equal(staticSequentialOmChildKey(3), "root/3/sequential/0");
	});

	it("formats static parallel keys as root/{stepIndex}/parallel/{taskIndex}", () => {
		assert.equal(staticParallelOmChildKey(1, 0), "root/1/parallel/0");
		assert.equal(staticParallelOmChildKey(1, 2), "root/1/parallel/2");
	});

	it("formats dynamic fanout keys as root/{stepIndex}/dynamic/{itemIndex}", () => {
		assert.equal(dynamicOmChildKey(2, 0), "root/2/dynamic/0");
		assert.equal(dynamicOmChildKey(2, 5), "root/2/dynamic/5");
	});

	it("keeps static and dynamic key spaces disjoint for the same step/index", () => {
		assert.notEqual(staticParallelOmChildKey(1, 0), dynamicOmChildKey(1, 0));
	});
});

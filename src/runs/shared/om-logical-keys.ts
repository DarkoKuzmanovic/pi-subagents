/**
 * Structural logical-child-key formulas for the M6.1 durable async OM protocol.
 *
 * A logical key identifies a child's *position in the chain plan*, independent of the
 * runtime-assigned `childId` slot. Static children get their keys pre-baked into the launch
 * manifest before detach (see `async-launch-binding.ts` / `collectStaticAsyncOmChildren`).
 * Dynamic-fanout items get keys minted by the runner at materialization time, durably appended
 * to the reopened manifest before the batch starts (see `async-om-outbox.ts`).
 *
 * These three formulas are the single source of truth for the key format — every producer of a
 * logical key (foreground manifest builder, spawn-time step builder, background runner) must go
 * through them so the manifest's static slots and the runner's step lookups never drift apart.
 */

export function staticSequentialOmChildKey(stepIndex: number): string {
	return `root/${stepIndex}/sequential/0`;
}

export function staticParallelOmChildKey(stepIndex: number, taskIndex: number): string {
	return `root/${stepIndex}/parallel/${taskIndex}`;
}

export function dynamicOmChildKey(stepIndex: number, itemIndex: number): string {
	return `root/${stepIndex}/dynamic/${itemIndex}`;
}

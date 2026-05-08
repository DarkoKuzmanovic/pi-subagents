/**
 * Recovery telemetry for Fix 1 (output recovery on non-zero exit).
 * Emits a structured event into the parent's session JSONL via pi.sendMessage.
 * Best-effort: swallows sendMessage errors so telemetry can never break the run.
 */

export interface RecoveryDetails {
	runId?: string;
	agent: string;
	exitCode: number;
	errorString: string;
	recoveredChars: number;
	elapsedMs?: number;
	mode: "single" | "chain";
	stepIndex?: number;
}

/**
 * Emit a recovery telemetry event.
 * Uses pi.sendMessage with display: false so the event goes into JSONL but not the chat.
 */
export function emitRecoveryEvent(
	pi: { sendMessage?: (msg: { customType: string; content: string; display: boolean; details: RecoveryDetails }, opts?: { triggerTurn: boolean }) => void } | undefined,
	details: RecoveryDetails,
): void {
	if (!pi?.sendMessage) return;
	try {
		const label = details.mode === "chain"
			? `chain/${details.agent}/step${details.stepIndex ?? 0}`
			: `single/${details.agent}`;
		pi.sendMessage(
			{
				customType: "subagent_recovery",
				content: `[recovery] ${label}: exit ${details.exitCode}, ${details.recoveredChars} chars recovered`,
				display: false,
				details,
			},
			{ triggerTurn: false },
		);
	} catch {
		// Best-effort: never let telemetry break the run
	}
}

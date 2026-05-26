/** Drain timer constants for managing process exit grace periods. */

export const FINAL_STOP_GRACE_MS = 1000;
export const HARD_KILL_MS = 3000;

export interface DrainTimers {
	finalDrainTimer: ReturnType<typeof setTimeout> | null;
	finalHardKillTimer: ReturnType<typeof setTimeout> | null;
}

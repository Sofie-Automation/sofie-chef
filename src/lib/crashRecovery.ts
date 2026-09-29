export interface CrashRecoveryOptions {
	/** Delay before the first automatic restart after a crash [ms] */
	initialDelay: number
	/** Maximum delay between automatic restarts after repeated crashes [ms] */
	maxDelay: number
	/** If the content has been alive for this long, a crash is considered a "new" one (resets the backoff) [ms] */
	stableThreshold: number
	/**
	 * Maximum random delay added on top of the backoff delay [ms].
	 * (This is to avoid multiple crashed windows restarting in lockstep,
	 * since renderer processes can be shared between windows displaying content from the same site.)
	 */
	maxJitter: number
}
export interface CrashRecoveryCallbacks {
	/** Performs the actual restart. */
	restart: () => Promise<void>
	/** Called when a restart has been scheduled. */
	onRestartScheduled: (delay: number, crashCount: number) => void
	/** Called when a restart attempt failed. (Another restart will be scheduled after this.) */
	onRestartFailed: (error: unknown) => void
}

export const DEFAULT_CRASH_RECOVERY_OPTIONS: CrashRecoveryOptions = {
	initialDelay: 1000,
	maxDelay: 30 * 1000,
	stableThreshold: 30 * 1000,
	maxJitter: 1000,
}

/**
 * Handles automatic restarts after crashes,
 * using an exponential backoff to avoid restarting too aggressively when the content is crash-looping.
 */
export class CrashRecovery {
	/** Number of crashes in the current crash-loop (resets after a period of stability) */
	private crashCount = 0
	/** Timestamp of when the content was last loaded successfully */
	private lastLoadTime = 0
	/** Timestamp of the last crash */
	private lastCrashTime = 0
	private restartTimeout: NodeJS.Timeout | null = null

	constructor(
		private readonly callbacks: CrashRecoveryCallbacks,
		private readonly options: CrashRecoveryOptions = DEFAULT_CRASH_RECOVERY_OPTIONS
	) {}

	/** Call this whenever the content has loaded successfully. */
	public notifyLoaded(): void {
		this.lastLoadTime = Date.now()
	}
	/** Call this when the content has crashed. Schedules an automatic restart. */
	public notifyCrash(): void {
		if (this.restartTimeout) return // A restart is already scheduled

		if (
			this.lastLoadTime > this.lastCrashTime && // The content has loaded successfully since the last crash
			Date.now() - this.lastLoadTime >= this.options.stableThreshold
		) {
			// The content had been stable for a while, so treat this as a new crash-loop:
			this.crashCount = 0
		}
		this.crashCount++
		this.lastCrashTime = Date.now()

		const delay = Math.min(
			this.options.initialDelay * 2 ** (this.crashCount - 1) + Math.floor(Math.random() * this.options.maxJitter),
			this.options.maxDelay
		)

		this.callbacks.onRestartScheduled(delay, this.crashCount)
		this.restartTimeout = setTimeout(() => {
			this.restartTimeout = null
			this.callbacks.restart().catch((err) => {
				this.callbacks.onRestartFailed(err)
				// Keep trying (with the backoff continuing to grow up to the max):
				this.notifyCrash()
			})
		}, delay)
	}
	/**
	 * Cancels any pending automatic restart.
	 * Call this when a restart happens for other reasons (like a manual restart), or when shutting down.
	 */
	public cancelPending(): void {
		if (this.restartTimeout) {
			clearTimeout(this.restartTimeout)
			this.restartTimeout = null
		}
	}
}

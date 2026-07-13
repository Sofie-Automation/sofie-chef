import { CrashRecovery, CrashRecoveryOptions } from './crashRecovery'

const OPTIONS: CrashRecoveryOptions = {
	initialDelay: 1000,
	maxDelay: 30 * 1000,
	stableThreshold: 30 * 1000,
	maxJitter: 1000,
}

describe('CrashRecovery', () => {
	let restart: jest.Mock<Promise<void>, []>
	let onRestartScheduled: jest.Mock
	let onRestartFailed: jest.Mock
	let crashRecovery: CrashRecovery

	beforeEach(() => {
		jest.useFakeTimers()
		jest.spyOn(Math, 'random').mockReturnValue(0) // No jitter, unless overridden in the test

		restart = jest.fn(async () => Promise.resolve())
		onRestartScheduled = jest.fn()
		onRestartFailed = jest.fn()
		crashRecovery = new CrashRecovery({ restart, onRestartScheduled, onRestartFailed }, OPTIONS)
	})
	afterEach(() => {
		jest.useRealTimers()
		jest.restoreAllMocks()
	})

	/** Simulates a successful load followed by a crash, and runs the scheduled restart */
	async function crashAndRestart(): Promise<void> {
		crashRecovery.notifyCrash()
		await jest.runOnlyPendingTimersAsync()
		crashRecovery.notifyLoaded()
	}

	it('restarts after the initial delay upon a crash', async () => {
		crashRecovery.notifyLoaded()
		crashRecovery.notifyCrash()

		expect(onRestartScheduled).toHaveBeenCalledWith(1000, 1)
		expect(restart).not.toHaveBeenCalled()

		await jest.advanceTimersByTimeAsync(999)
		expect(restart).not.toHaveBeenCalled()

		await jest.advanceTimersByTimeAsync(1)
		expect(restart).toHaveBeenCalledTimes(1)
	})

	it('ignores crash notifications while a restart is already scheduled', async () => {
		crashRecovery.notifyCrash()
		crashRecovery.notifyCrash()
		crashRecovery.notifyCrash()

		expect(onRestartScheduled).toHaveBeenCalledTimes(1)

		await jest.runOnlyPendingTimersAsync()
		expect(restart).toHaveBeenCalledTimes(1)
	})

	it('uses an exponential backoff for repeated crashes, capped at maxDelay', async () => {
		const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000]

		for (let i = 0; i < expectedDelays.length; i++) {
			await crashAndRestart()
			expect(onRestartScheduled).toHaveBeenNthCalledWith(i + 1, expectedDelays[i], i + 1)
		}
		expect(restart).toHaveBeenCalledTimes(expectedDelays.length)
	})

	it('resets the backoff after a period of stability', async () => {
		// Cause a few crashes, to build up the backoff:
		await crashAndRestart()
		await crashAndRestart()
		expect(onRestartScheduled).toHaveBeenNthCalledWith(2, 2000, 2)

		// Let the content be stable for longer than the stableThreshold:
		await jest.advanceTimersByTimeAsync(OPTIONS.stableThreshold + 1)

		crashRecovery.notifyCrash()
		expect(onRestartScheduled).toHaveBeenNthCalledWith(3, 1000, 1)
	})

	it('does not reset the backoff if the stability period was too short', async () => {
		await crashAndRestart()

		await jest.advanceTimersByTimeAsync(OPTIONS.stableThreshold - 1)

		crashRecovery.notifyCrash()
		expect(onRestartScheduled).toHaveBeenNthCalledWith(2, 2000, 2)
	})

	it('does not restart after cancelPending() has been called', async () => {
		crashRecovery.notifyCrash()
		crashRecovery.cancelPending()

		await jest.runAllTimersAsync()
		expect(restart).not.toHaveBeenCalled()

		// A new crash schedules a new restart:
		crashRecovery.notifyCrash()
		await jest.runOnlyPendingTimersAsync()
		expect(restart).toHaveBeenCalledTimes(1)
	})

	it('schedules another restart (with increased backoff) if the restart fails', async () => {
		const error = new Error('load failed')
		restart.mockRejectedValueOnce(error)

		crashRecovery.notifyCrash()
		await jest.runOnlyPendingTimersAsync()

		expect(restart).toHaveBeenCalledTimes(1)
		expect(onRestartFailed).toHaveBeenCalledWith(error)
		expect(onRestartScheduled).toHaveBeenNthCalledWith(2, 2000, 2)

		// The second attempt succeeds:
		await jest.runOnlyPendingTimersAsync()
		expect(restart).toHaveBeenCalledTimes(2)
		expect(onRestartFailed).toHaveBeenCalledTimes(1)
	})

	it('keeps growing the backoff during repeated failed restarts, even if the last successful load was long ago', async () => {
		// The content loads and is stable for a long time:
		crashRecovery.notifyLoaded()
		await jest.advanceTimersByTimeAsync(10 * 60 * 1000)

		// Then it crashes, and all restart attempts fail (e.g. the content server is down):
		restart.mockRejectedValue(new Error('load failed'))
		crashRecovery.notifyCrash()

		for (let i = 0; i < 5; i++) {
			await jest.runOnlyPendingTimersAsync()
		}

		// The backoff must not have been reset by the stale "stable period":
		expect(onRestartScheduled).toHaveBeenNthCalledWith(6, 30000, 6)
	})

	it('adds a random jitter of up to maxJitter to the delay', () => {
		jest.spyOn(Math, 'random').mockReturnValue(0.999)

		crashRecovery.notifyCrash()
		expect(onRestartScheduled).toHaveBeenCalledWith(1999, 1)
	})
})

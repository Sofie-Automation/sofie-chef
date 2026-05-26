import { BrowserWindow, ipcMain } from 'electron'
import { EventEmitter } from 'events'
import { IpcMethods, ReportStatusIpcPayload, StatusObject } from '../lib/api'
import { Config, ConfigWindow } from '../lib/config'
import { rateLimitAndDoLater } from '../lib/lib'
import { Logger } from '../lib/logging'

import { WindowHelper } from './WindowHelper'

/** The AllWindowsManager is responsible for spawning the various windows */
export class AllWindowsManager extends EventEmitter {
	private windowsHandlers: { [id: string]: WindowHelper } = {}
	private lastFocusedWindow: WindowHelper | undefined

	private static _singletonInstance: AllWindowsManager
	private constructor(private logger: Logger) {
		super()

		ipcMain.on(IpcMethods.ReportStatus, (event, payload: ReportStatusIpcPayload) => {
			const browserWindow = BrowserWindow.fromWebContents(event.sender)
			if (!browserWindow) return

			this.getAllWindows().forEach((w) => w.window.receiveExternalStatus(browserWindow, payload))
		})
	}

	static GetAllWindowsManager(logger: Logger): AllWindowsManager {
		// return singleton
		this._singletonInstance = this._singletonInstance ?? new AllWindowsManager(logger)
		return this._singletonInstance
	}

	public initialize(): void {
		// nothing
	}

	public getWindow(id: string): WindowHelper | undefined {
		return this.windowsHandlers[id]
	}

	public getAllWindows(): { id: string; window: WindowHelper }[] {
		return Object.entries<WindowHelper>(this.windowsHandlers).map(([id, window]) => ({ id, window }))
	}

	public getLastFocusedWindow(): WindowHelper | undefined {
		return this.lastFocusedWindow
	}

	public getWindowForWebContents(webContents: Electron.WebContents): WindowHelper | undefined {
		return Object.values<WindowHelper>(this.windowsHandlers).find((window) => window.isWebContents(webContents))
	}

	public getWindowForFrame(frame: Electron.WebFrameMain | null): WindowHelper | undefined {
		if (!frame) return undefined

		const mainFrame = frame.top ?? frame
		return Object.values<WindowHelper>(this.windowsHandlers).find((window) => window.isMainFrame(mainFrame))
	}

	public getWindowForOrigin(origin: string): WindowHelper | undefined {
		return Object.values<WindowHelper>(this.windowsHandlers).find((window) => window.isOrigin(origin))
	}

	public getStatus(): { [index: string]: StatusObject } {
		const status: { [index: string]: StatusObject } = {}

		for (const [id, window] of Object.entries<WindowHelper>(this.windowsHandlers)) {
			status[id] = window.status
		}
		return status
	}

	/**
	 * Trigger an update to the windows
	 * @param config
	 * @returns
	 */
	public triggerUpdateWindows = rateLimitAndDoLater(this._updateWindows.bind(this), 200, this.logger.error)
	/** Update all windows from config */
	private async _updateWindows(config: Config) {
		const removeWindowIds = new Set<string>()
		for (const id of Object.keys(this.windowsHandlers)) {
			removeWindowIds.add(id)
		}

		for (const [id, configWindow] of Object.entries<ConfigWindow>(config.windows)) {
			if (configWindow.disable) continue

			removeWindowIds.delete(id)

			const window = this.windowsHandlers[id]

			if (!window) {
				// Create a new window
				this.logger.info(`Create new window "${id}", ${JSON.stringify(configWindow)}`)
				const winHandler = new WindowHelper(this.logger, id, config, configWindow, `Chef | ${id}`)
				this.windowsHandlers[id] = winHandler

				winHandler.on('window-has-been-modified', () => {
					this.emit('window-has-been-modified')
				})
				winHandler.on('status', (status: StatusObject) => {
					this.logger.info(`Status for "${id}": ${status.statusCode} ${status.message}`)
					this.emit('status', this.getStatus())
				})
				winHandler.on('focus', () => {
					this.lastFocusedWindow = winHandler
				})
				winHandler.on('closed', () => {
					this.emit('closed-window', id)
				})
				this.lastFocusedWindow = winHandler
				await winHandler.init()
			} else {
				// Update existing window
				// this.logger.info(`Update window "${id}", ${JSON.stringify(configWindow)}`)
				await window.updateConfig(config, configWindow)
			}
		}

		for (const id of removeWindowIds.values()) {
			// Close the window
			this.logger.info(`Close window "${id}"`)
			await this.windowsHandlers[id].close()
			delete this.windowsHandlers[id]
		}
	}
}

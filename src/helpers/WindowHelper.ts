import { BrowserWindow, screen } from 'electron'
import { EventEmitter } from 'events'
import { ConfigWindow, ConfigWindowAllowedWebHIDDevice, ConfigWindowShared } from '../lib/config'
import _ = require('underscore')
import { Logger } from '../lib/logging'
import { ReportStatusIpcPayload, StatusCode, StatusObject } from '../lib/api'
import * as path from 'path'
import urlJoin = require('url-join')
import { Queue } from '../lib/queue'

export class WindowHelper extends EventEmitter {
	private window: BrowserWindow

	private userAgent = 'sofie-chef' // (placeholder, is set properly later)

	/** empty string means a blank page, null means defaultURL */
	private _url: string | null = null

	private _status: StatusObject = {
		statusCode: StatusCode.ERROR,
		message: 'N/A',
	}
	private _contentStatus?: StatusObject

	/**
	 * A value that changes whenever the content is changed.
	 * Used to abort asynchronous operations if the content has changed.
	 */
	private updateHash = 0

	private queue = new Queue()

	constructor(
		private logger: Logger,
		public readonly id: string,
		private _sharedConfig: ConfigWindowShared,
		private _config: ConfigWindow,
		private title: string
	) {
		super()

		// Put the public methods in a queue, to ensure that they are run in order:
		this.close = this.queue.bindMethod(this.close.bind(this), { reason: 'close' })
		this.updateConfig = this.queue.bindMethod(this.updateConfig.bind(this), { reason: 'updateConfig' })
		this.playURL = this.queue.bindMethod(this.playURL.bind(this), { reason: 'playURL' })
		this.restart = this.queue.bindMethod(this.restart.bind(this))
		this.stop = this.queue.bindMethod(this.stop.bind(this), { reason: 'stop' })
		this.executeJavascript = this.queue.bindMethod(this.executeJavascript.bind(this))

		this.window = new BrowserWindow({
			height: this.config.height,
			width: this.config.width,
			x: this.config.x,
			y: this.config.y,

			frame: !this.config.frameless,
			webPreferences: {
				preload: path.join(__dirname, '../lib/preload.js'),
			},
			title: this.title,
		})

		this.window.removeMenu()

		this.window.on('resized', () => {
			this.logger.info(`Window "${this.id}": resized`)
			this._updateSizeAndPosition()
		})
		this.window.on('moved', () => {
			this.logger.info(`Window "${this.id}": moved`)
			this._updateSizeAndPosition()
		})
		this.window.on('maximize', () => {
			this.logger.info(`Window "${this.id}": maximized`)
			this._updateSizeAndPosition()
		})
		this.window.on('unmaximize', () => {
			this.logger.info(`Window "${this.id}": unmaximized`)
			this._updateSizeAndPosition()
		})
		this.window.on('focus', () => {
			this.emit('focus')
		})
		this.window.on('close', () => {
			this.logger.info(`Window "${this.id}": closed`)
			this.emit('closed')
		})
		this.window.on('unresponsive', () => {
			// Emitted when the web page becomes unresponsive.
			this.logger.warn(`Window "${this.id}": unresponsive`)
		})
		this.window.on('responsive', () => {
			// Emitted when the unresponsive web page becomes responsive again.
			this.logger.warn(`Window "${this.id}": responsive`)
		})

		this.logger.info(`Creating new window "${this.id}"`)
	}
	public get config(): ConfigWindow {
		return this._config
	}
	public hasAllowedWebHIDDevices(): boolean {
		return (this._config.allowedWebHIDDevices?.length ?? 0) > 0
	}
	public isWebContents(webContents: Electron.WebContents): boolean {
		return this.window.webContents === webContents
	}
	public isMainFrame(frame: Electron.WebFrameMain | null): boolean {
		if (!frame) return false

		const mainFrame = this.window.webContents.mainFrame
		return mainFrame.processId === frame.processId && mainFrame.routingId === frame.routingId
	}
	public isOrigin(origin: string): boolean {
		const currentUrl = this.window.webContents.getURL()
		if (!currentUrl) return false

		try {
			return new URL(currentUrl).origin === origin
		} catch {
			return false
		}
	}
	public isAllowedWebHIDDevice(device: Electron.HIDDevice): boolean {
		const allowedDevices = this._config.allowedWebHIDDevices ?? []

		for (const allowedDevice of allowedDevices) {
			if (!this._matchesVendorAndProduct(device, allowedDevice)) continue
			if (!this._matchesUsageFilter(device, allowedDevice)) continue

			return true
		}

		return false
	}
	public get url(): string | null {
		return this._url
	}
	public async init(): Promise<void> {
		// Set the user-agent:
		this.userAgent = this.window.webContents.getUserAgent() + ' sofie-chef'

		await this._updateWindow()
		// Trigger loading default page:
		// await this.restart()
		// await mainWindow.loadFile(path.join(__dirname, '../static/index.html'))
		// await mainWindow.loadURL(`file://${app.getAppPath()}/dist/index.html`)
	}
	/** Closes the window. */
	public async close(): Promise<void> {
		// Note: This Method runs in a queue!
		this.logger.info(`Closing window "${this.id}"`)
		this.window.close()
	}
	public async updateConfig(sharedConfig: ConfigWindowShared, config: ConfigWindow): Promise<void> {
		// Note: This Method runs in a queue!
		const oldConfig = this._config
		this._sharedConfig = sharedConfig
		this._config = config

		if (!_.isEqual(oldConfig, config)) {
			await this._updateWindow(oldConfig)
		}
	}
	public toggleFullScreen(): void {
		this.window.setFullScreen(!this.window.isFullScreen())
		this._updateSizeAndPosition()
	}
	public toggleDevTools(): void {
		this.window.webContents.toggleDevTools()
	}
	/** Restarts (reloads) the window. */
	public async restart(): Promise<void> {
		// Note: This Method runs in a queue!
		return this._restart()
	}
	/** Play the specified URL in the window */
	public async playURL(url: string | null): Promise<void> {
		// Note: This Method runs in a queue!
		return this._playURL(url)
	}
	/**
	 * Stops playing the content in window
	 */
	public async stop(): Promise<void> {
		// Note: This Method runs in a queue!
		await this._playURL(null)
	}
	/**
	 * Executes a javascript inside the web player
	 * (This Method runs in a queue.)
	 */
	public async executeJavascript(script: string): Promise<void> {
		await this.window.webContents.executeJavaScript(script)
	}
	public getURL(): string {
		const windowUrl = this._url ?? this._config.defaultURL

		if (this._sharedConfig.baseURL && !windowUrl.match(/^(?:[a-z+]+:)?\/\//i)) {
			// URL does not look absolute, add the baseURL
			return urlJoin(this._sharedConfig.baseURL, windowUrl)
		} else {
			return windowUrl
		}
	}
	public receiveExternalStatus(browserWindow: BrowserWindow, payload: ReportStatusIpcPayload): void {
		if (browserWindow !== this.window) return

		this.status = {
			statusCode: payload.status,
			message: payload.message || '',
		}
	}

	public get status(): StatusObject {
		let status = this._status
		if (this._contentStatus && this._contentStatus.statusCode > status.statusCode) {
			status = this._contentStatus
		}
		return status
	}
	private set status(status: StatusObject) {
		if (this._status.statusCode !== status.statusCode || this._status.message !== status.message) {
			this._status = status
			this._emitStatus()
		}
	}

	private async _playURL(url: string | null): Promise<void> {
		if (this._url !== url) {
			this._url = url

			await this._restart()
		}
	}
	/** Restarts (reloads) the window */
	private async _restart(): Promise<void> {
		delete this._contentStatus
		const updateHash = ++this.updateHash

		try {
			const url = this.getURL() || 'about:blank'

			this.logger.info(`Window "${this.id}": Load url "${url}"`)
			await this.window.loadURL(url, {
				userAgent: this.userAgent,
			})
			if (updateHash !== this.updateHash) return // Abort if the updateHash has changed

			this.logger.info(`Window "${this.id}": Loaded url "${url}"`)
			const defaultColor = this.config.defaultColor ?? '#000000' // ie: an empty string = don't set any color
			if (defaultColor) {
				// Set the background color, to avoid white flashes when loading:
				await this.window.webContents.insertCSS(`html, body { background-color: ${defaultColor}; }`)
			}

			this._setupWebContentListeners()

			this.window.setTitle(this.title)
			this.window.webContents.setZoomFactor((this.config.zoomFactor ?? 100) / 100)

			if (this.config.displayDebug) {
				await this._displayDebugOverlay()
			}

			if (updateHash !== this.updateHash) return // Abort if the updateHash has changed

			await this._injectUpdateCSS()
		} catch (err) {
			this.status = {
				statusCode: StatusCode.ERROR,
				message: `Error when loading "${this._url}": ${err}`,
			}
			throw err
		}

		this.status = {
			statusCode: StatusCode.GOOD,
			message: ``,
		}
	}

	private _emitStatus() {
		this.emit('status', this.status)
	}
	private async _updateWindow(oldConfig?: ConfigWindow): Promise<void> {
		if (
			this.config.x !== undefined &&
			this.config.y !== undefined &&
			this.config.height !== undefined &&
			this.config.width !== undefined
		) {
			if (this.config.canSpanMultipleDisplays) {
				this.window.setBounds({
					x: this.config.x,
					y: this.config.y,
					width: this.config.width,
					height: this.config.height,
				})
			} else {
				// Hack to make it work on Windows with multi-dpi screens
				// Ref: https://github.com/electron/electron/pull/10972
				const bestDisplay = screen.getDisplayMatching({
					height: this.config.height,
					width: this.config.width,
					x: this.config.x,
					y: this.config.y,
				})

				this.window.setBounds({
					x: Math.max(this.config.x, bestDisplay.workArea.x),
					y: Math.max(this.config.y, bestDisplay.workArea.y),
					width: Math.min(this.config.width, bestDisplay.workArea.width),
					height: Math.min(this.config.height, bestDisplay.workArea.height),
				})
			}
		} else {
			this.window.setBounds({
				width: this.config.width,
				height: this.config.height,
			})
		}

		this.window.setFullScreen(this.config.fullScreen)

		if (this.config.onTop) {
			// Note: Some popups are only displayed below if running in fullscreen as well.
			this.window.setAlwaysOnTop(true, 'screen-saver')
		} else {
			this.window.setAlwaysOnTop(false)
		}

		if (this.config.zoomFactor !== oldConfig?.zoomFactor) {
			this.window.webContents.setZoomFactor((this.config.zoomFactor ?? 100) / 100)
		}
		if (
			this.window.webContents.getURL() !== this.getURL() ||
			this.config.displayDebug !== oldConfig?.displayDebug ||
			this.config.hideCursor !== oldConfig?.hideCursor ||
			this.config.hideScrollbar !== oldConfig?.hideScrollbar
		) {
			await this._restart()
		}

		this.window.moveTop()
	}

	private _updateSizeAndPosition() {
		this.config.fullScreen = this.window.isFullScreen()

		// No need to update position and size if it's fullscreen anyway.
		// That way, we're able to "restore" the window when making it not fullscreen:
		if (!this.config.fullScreen) {
			const newBounds = this.window.getBounds()
			this.config.x = newBounds.x
			this.config.y = newBounds.y
			this.config.width = newBounds.width
			this.config.height = newBounds.height
		}

		this.emit('window-has-been-modified')
	}

	private _setupWebContentListeners() {
		this.window.webContents.off('render-process-gone', this._handleRenderProcessGone)
		this.window.webContents.on('render-process-gone', this._handleRenderProcessGone)

		this.window.webContents.off('console-message', this._handleConsoleMessage)
		this.window.webContents.on('console-message', this._handleConsoleMessage)
	}
	private _handleRenderProcessGone = (event: Electron.Event, details: Electron.RenderProcessGoneDetails): void => {
		if (details.reason !== 'clean-exit') {
			this.status = {
				statusCode: StatusCode.ERROR,
				message: `Renderer process gone "${this._url}": ${details.reason}, ${details.exitCode}, "${event}"`,
			}
		}
	}
	private _handleConsoleMessage = (
		_event: Electron.Event,
		level: number,
		message: string,
		line: number,
		sourceId: string
	): void => {
		if (this.config.logContent) {
			const logMessage = `[${level}] ${message} at ${sourceId}:${line}`
			this.logger.debug(`${this.id}: ${logMessage}`)
		}
	}
	private async _displayDebugOverlay() {
		await this.window.webContents.executeJavaScript(`
function setupMonitor() {
	var overlay = document.createElement('div');
	overlay.style.cssText = 'display: block;position:fixed;top:0;right: 0;z-index:99999;color: #0f0;font-family: monospace;background: rgba(0,0,0,0.2);padding: 3px;';
	document.body.appendChild(overlay);

	var lastFrameTime = performance.now();
	var avgFps = 0;

	function updateFrame () {
		var now = performance.now();
		var frameDuration = now - lastFrameTime;
		lastFrameTime = now;

		var fps = 1000 / frameDuration;

		if (!avgFps) avgFps = fps;

		avgFps += (fps - avgFps) * 0.02 // Gliding average;

		overlay.innerHTML = (
			'<b>${this.id}</b>'+
			'<br>${this.getURL() || 'blank'}'+
			'<br>FPS: ' + Math.round(fps) +
			'<br>AVG FPS: ' + Math.round(avgFps)
		);
		requestAnimationFrame(updateFrame);
	}
	requestAnimationFrame(() => {
		lastFrameTime = performance.now();
		requestAnimationFrame(updateFrame);
	})
}
setupMonitor();`)
	}
	private async _injectUpdateCSS() {
		if (this.config.hideCursor ?? true) {
			// Hide cursor:
			// This should hide the cursor for most elements that sets their own cursor
			//  (though it's not perfect if the content sets the cursor for an element AND uses "!important")
			await this.window.webContents.insertCSS('html, body, * { cursor: none !important; }')

			// Disable pointer events:
			// This should disable any hover / click events.
			await this.window.webContents.insertCSS('html, body, * { pointer-events: none !important; }')
		}

		if (this._config.hideScrollbar) {
			await this.window.webContents.insertCSS('html, body { overflow: hidden !important; }')
		}

		// Also update the CSS every frame, to override anything that the content might try:
		await this.window.webContents.executeJavaScript(`
function setupUpdateCSS() {
	var body = document.getElementsByTagName('body')[0]
	var html = document.getElementsByTagName('html')[0]
	var hideCursor = ${this._config.hideCursor ?? true}
	var hideScrollbar = ${this._config.hideScrollbar ?? false}

	function updateCSS () {
		if (hideCursor) {
			if (body.style.cursor !== 'none') body.style.setProperty('cursor', 'none', 'important')
		}
		if (hideScrollbar) {
			if (body.style.overflow !== 'hidden') body.style.setProperty('overflow', 'hidden', 'important')
		}

		requestAnimationFrame(updateCSS);
	}
	requestAnimationFrame(() => {
		requestAnimationFrame(updateCSS);
	})
}
setupUpdateCSS();`)
	}
	private _matchesVendorAndProduct(
		device: Electron.HIDDevice,
		allowedDevice: ConfigWindowAllowedWebHIDDevice
	): boolean {
		return device.vendorId === allowedDevice.vendorId && device.productId === allowedDevice.productId
	}
	private _matchesUsageFilter(device: Electron.HIDDevice, allowedDevice: ConfigWindowAllowedWebHIDDevice): boolean {
		const hasUsagePageFilter = allowedDevice.usagePage !== undefined
		const hasUsageFilter = allowedDevice.usage !== undefined

		if (!hasUsagePageFilter && !hasUsageFilter) return true

		return device.collections.some((collection) => {
			const usagePageMatches = !hasUsagePageFilter || collection.usagePage === allowedDevice.usagePage
			const usageMatches = !hasUsageFilter || collection.usage === allowedDevice.usage

			return usagePageMatches && usageMatches
		})
	}
}

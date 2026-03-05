import * as fs from 'fs/promises'
import * as path from 'path'
import * as chokidar from 'chokidar'
import * as _ from 'underscore'
import { App, shell } from 'electron'
import { EventEmitter } from 'events'
import { Logger } from '../lib/logging'
import { fsExists } from '../lib/lib'
import { Config, ConfigWindow, DEFAULT_CONFIG } from '../lib/config'

/** The ConfigHelper is responsible for reading and writing to the Config-file */
export class ConfigHelper extends EventEmitter {
	/**
	 * The In-memory copy of the Config.
	 * This is NOT a read-only object, but can be updated in other parts of the application.
	 * When an update to the config-object has been done, this.onUpdatedConfig(true) is to be called
	 * in order to persist the data.
	 */
	private config: Config | undefined = undefined
	private _initialized = false

	private static _singletonInstance: ConfigHelper
	private constructor(private logger: Logger, private app: App) {
		super()
	}

	static GetConfigHelper(logger: Logger, app: App): ConfigHelper {
		// return singleton
		this._singletonInstance = this._singletonInstance ?? new ConfigHelper(logger, app)
		return this._singletonInstance
	}

	/** Initialize the ConfigHelper */
	public initialize(): void {
		if (this._initialized) return
		this._initialized = true

		fs.mkdir(this.homePath).catch((e) => this.logger.error(e))

		this.setupMonitorConfigFile()

		this.logger.info(`Config file path: "${this.configFilePath}"`)
	}
	public addWindow(): void {
		if (this.config) {
			let nextWindowId = ''
			for (let i = 0; i < 999; i++) {
				nextWindowId = 'window_' + i
				if (!this.config.windows[nextWindowId]) {
					break
				}
			}
			this.config.windows[nextWindowId] = DEFAULT_CONFIG.windows.default
			this.onModifiedConfig(true)
		}
	}
	public removeWindow(id: string): void {
		if (this.config) {
			delete this.config.windows[id]

			this.onModifiedConfig(true)
		}
	}

	/** Called when the config object has been modified */
	public onModifiedConfig(
		/** Whether the modified config needs to be written to disk. true by default */
		configNeedsWrite = true
	): void {
		if (configNeedsWrite) {
			if (this.config && !this.config?.freeze) {
				// Write the config changes to file:
				this.logger.debug(`Writing config file to disk, to "${this.configFilePath}"`)
				fs.writeFile(this.configFilePath, JSON.stringify(this.config, undefined, 2)).catch(this.logger.error)
			}
		}
		this.emit('updated-config', this.config)
	}

	/** Opens the config file in the OS default editor */
	public openFileInDefaultEditor(): void {
		shell.openPath(this.configFilePath).catch((e) => this.logger.error(e))
	}

	/** Sets up monitoring of config file */
	private setupMonitorConfigFile() {
		// Trigger an initial read of the config file:
		this.onConfigFileChanged()

		chokidar
			.watch(this.configFilePath, {
				awaitWriteFinish: {
					stabilityThreshold: 500,
					pollInterval: 100,
				},
			})
			.on('all', () => {
				this.onConfigFileChanged()
			})
	}
	/** Called when the config file in disk has changed */
	private onConfigFileChanged() {
		this.readConfigFile()
			.then(async (config) => {
				if (!config) {
					this.config = DEFAULT_CONFIG
					this.onModifiedConfig(true)
				} else {
					this.ensureCompatibility(config)

					if (!_.isEqual(this.config, config)) {
						this.config = config
						this.onModifiedConfig(false)
					}
				}
			})
			.catch(this.logger.error)
	}
	private ensureCompatibility(config: Config): void {
		const anyConfig = config as any
		if (Array.isArray(anyConfig.windows)) {
			const windowsArray = anyConfig.windows as ConfigWindow[]
			config.windows = {}
			for (let i = 0; i < windowsArray.length; i++) {
				const window = windowsArray[i]
				const windowId = 'window_' + i
				config.windows[windowId] = window
			}
		}

		for (const window of Object.values<ConfigWindow>(config.windows)) {
			if (window.disable === undefined) window.disable = false
			if (window.canSpanMultipleDisplays === undefined) window.canSpanMultipleDisplays = false
		}
	}
	/** Returns the path of the folder where we store the config file. */
	private get homePath(): string {
		if (this.app.isPackaged) {
			// Use the users home catalog:
			return path.join(this.app.getPath('userData'), 'sofie-chef')
		} else {
			// When in development-mode, just use the base folder of the repo:
			return path.join(
				this.app.getAppPath(), // ./dist
				'..'
			)
		}
	}
	/** Returns the path of the config file */
	private get configFilePath(): string {
		return path.join(this.homePath, 'config.json')
	}
	private async readConfigFile(): Promise<Config | undefined> {
		if (await fsExists(this.configFilePath)) {
			const fileStr = await fs.readFile(this.configFilePath, 'utf8')
			try {
				return JSON.parse(fileStr) as Config
			} catch (err) {
				this.logger.error(err)
				return undefined
			}
		} else {
			return undefined
		}
	}
}

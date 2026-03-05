export interface ConfigWindowShared {
	/** The base URL to prepend to relative URLs */
	baseURL?: string
}
export interface Config extends ConfigWindowShared {
	/** If true, won't update the config file automatically. */
	freeze: boolean
	/** Which port to start the API on. */
	apiPort: number | undefined | null
	/** When set, require all API requests to set apiKey */
	apiKey?: string
	/** A list of the windows to be created */
	windows: { [id: string]: ConfigWindow }
}
export interface ConfigWindow {
	/** X-position of the window */
	x: number | undefined
	/** Y-position of the window */
	y: number | undefined
	/** Width of the window */
	width: number
	/** Height of the window */
	height: number

	/** Set this to true to avoid Chef ensuring that a window is clamped to within a single display */
	canSpanMultipleDisplays: boolean

	disable: boolean

	/** Set to true to make the window fullscreen */
	fullScreen: boolean
	/** Set to true make the window always-on-top */
	onTop?: boolean

	/** When true, will display an overlay with debug information */
	displayDebug?: boolean

	/** When true, web-content console.log will be output to console */
	logContent?: boolean

	/**
	 * Set to true to make the window "frameless" (borderless).
	 * This could be useful in a situation where you don't want a fullscreen window
	 */
	frameless?: boolean

	/** The default URL to load on startup */
	defaultURL: string

	/** The default background color to use. Defaults to black. Set to empty string to disable. */
	defaultColor: string

	/** Hide cursor on top of window content. Defaults to true */
	hideCursor: boolean

	/** Hide any scrollbars for the displayed content. Defaults to false */
	hideScrollbar: boolean

	/** Zoom factor of the content. Default is 100 (%) */
	zoomFactor?: number
}

export const DEFAULT_CONFIG: Config = {
	freeze: false,
	apiPort: 5270,
	apiKey: '',
	windows: {
		default: {
			disable: false,
			x: undefined,
			y: undefined,
			width: 1280,
			height: 720,
			canSpanMultipleDisplays: false,
			fullScreen: false,
			onTop: false,
			frameless: false,
			displayDebug: true,
			defaultURL: 'https://bouncingdvdlogo.com/',
			defaultColor: '#000000',
			hideCursor: true,
			hideScrollbar: false,
			zoomFactor: 100,
		},
	},
}

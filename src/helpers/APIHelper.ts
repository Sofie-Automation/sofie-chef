import * as Koa from 'koa'
import * as cors from '@koa/cors'
import * as Router from 'koa-router'
import * as bodyParser from 'koa-bodyparser'
import { AllWindowsManager } from './AllWindowsManager'
import { Logger } from '../lib/logging'
import { WebSocketServer, WebSocket, RawData } from 'ws'
import {
	ReceiveWSMessageAny,
	ReceiveWSMessageType,
	SendWSMessageAny,
	SendWSMessageType,
	StatusCode,
	SendWSMessageStatus,
	APIResponseBase,
	ReceiveWSMessageResponse,
} from '../lib/api'
import { rateLimitAndDoLater } from '../lib/lib'
import { Config } from '../lib/config'

// How long to wait for status changes to settle before broadcasting
const STATUS_SETTLE_TIME = 3000

export class APIHelper {
	private httpServer: Koa | undefined
	private wsServer: WebSocketServer | undefined

	private connectedClients: {
		ws: WebSocket
		connectionId: number
		statusInterval: NodeJS.Timeout
	}[] = []
	private connectedId = 0

	private config: Config | undefined = undefined

	private status: SendWSMessageStatus['status'] = {
		app: {
			statusCode: StatusCode.GOOD,
			message: '',
		},
		windows: {},
	}
	private static _singletonInstance: APIHelper
	private constructor(private logger: Logger, private windowsHelper: AllWindowsManager) {
		// Nothing
	}
	static GetAPIHelper(logger: Logger, windowsHelper: AllWindowsManager): APIHelper {
		// return singleton
		this._singletonInstance = this._singletonInstance ?? new APIHelper(logger, windowsHelper)
		return this._singletonInstance
	}
	public init(config: Config): void {
		this.config = config
		this.setupHTTPServer()
		this.setupWSServer()
	}
	public setStatus(status: SendWSMessageStatus['status']): void {
		this.status = status

		this.broadcastStatusToClients()
	}

	private setupHTTPServer(): void {
		if (this.httpServer) return
		if (!this.config) throw new Error('this.config not set, call init() first!')
		if (!this.config.apiPort) return

		const httpPort = this.config.apiPort
		const apiKey = this.config.apiKey

		this.logger.info(`Starting HTTP server on port ${httpPort}...`)

		this.httpServer = new Koa()
		const router = new Router()

		this.httpServer.use(bodyParser())

		this.httpServer.use(
			cors({
				origin: '*', // TODO: cors
			})
		)

		this.httpServer.on('error', (err) => {
			const errString = `${err}`

			// We get a lot of these errors, ignore them:
			if (errString.match(/ECONNRESET|ECONNABORTED|ECANCELED/)) {
				// ignore these
			} else {
				this.logger.error(`PackageProxyServer Error: ${errString}`)
			}
		})

		router.all(/.*/, async (ctx, next) => {
			// Intercept and authenticate:
			const requestApiKey: string | undefined =
				firstInArray(ctx.request.query?.apiKey) || // Querystring parameter
				((ctx.request.body as any)?.apiKey as string) // Body parameter

			if (!apiKey || apiKey === requestApiKey) {
				return next() // OK
			} else {
				this.logger.warn(`[403] ${ctx.request.URL}`)

				ctx.response.status = 403
				ctx.body = 'Api key "?apiKey=API_KEY" missing or is invalid.'
			}
		})

		router.get('/api/status', async (ctx) => {
			ctx.response.status = 200
			ctx.body = this.status
		})
		router.put('/api/playURL/:windowId', async (ctx) => {
			const body = ctx.request.body as Record<string, string> | undefined
			const url = body?.url // Body parameter
			const jsCode = body?.jsCode // Body parameter

			const r = await this.apiPlayURL(ctx.params.windowId, url, jsCode)
			ctx.response.status = r.code
			ctx.body = r.body
		})
		router.put('/api/restart/:windowId', async (ctx) => {
			const r = await this.apiRestart(ctx.params.windowId)
			ctx.response.status = r.code
			ctx.body = r.body
		})
		router.put('/api/stop/:windowId', async (ctx) => {
			const r = await this.apiStop(ctx.params.windowId)
			ctx.response.status = r.code
			ctx.body = r.body
		})
		router.post('/api/execute/:windowId', async (ctx) => {
			const body = ctx.request.body as Record<string, string> | undefined
			const jsCode = body?.jsCode // Body parameter

			const r = await this.apiExecute(ctx.params.windowId, jsCode)
			ctx.response.status = r.code
			ctx.body = r.body
		})
		router.get('/api/list', async (ctx) => {
			const r = await this.apiList()
			ctx.response.status = r.code
			ctx.body = r.body
		})

		router.get('/api', async (ctx) => {
			ctx.response.status = 200
			ctx.body = `
<a href="/api/status?apiKey=${this.config?.apiKey}">GET /api/status</a><br>
<a href="/api/list?apiKey=${this.config?.apiKey}">GET /api/list</a><br>
PUT /api/playURL/:windowId body: {"url": "", "jsCode": "" }<br>
PUT /api/restart/:windowId<br>
PUT /api/stop/:windowId<br>
POST /api/execute/:windowId body: {"jsCode": "" }<br>
`
		})

		this.httpServer.use(router.routes()).use(router.allowedMethods())

		this.httpServer.use((ctx) => {
			ctx.body = 'Page not found'
			ctx.response.status = 404
		})

		this.httpServer.listen(httpPort, () => {
			this.logger.info(`HTTP server listening on port ${httpPort}`)
		})
	}
	private setupWSServer(): void {
		if (this.wsServer) return
		if (!this.config) throw new Error('this.config not set, call init() first!')
		if (!this.config.apiPort) return

		const wsPort = this.config.apiPort + 1

		this.logger.info(`Starting websocket server on port ${wsPort}...`)

		this.wsServer = new WebSocketServer({
			port: wsPort,
		})

		this.wsServer.on('connection', (ws, request) => {
			// A client has connected!

			const connectionId = this.connectedId++

			this.connectedClients.push({
				ws,
				connectionId,
				statusInterval: setInterval(() => {
					this.sendStatusToClient(ws)
				}, 60000), // Every minute
			})

			let remoteAddress = request.socket.remoteAddress || 'N/A'
			if (request.socket.remotePort) {
				remoteAddress += ':' + request.socket.remotePort
			}

			this.logger.debug(`New connection "${connectionId}" opened from ${remoteAddress}`)

			const onMessage = (raw: RawData) => {
				let message: ReceiveWSMessageAny | undefined = undefined
				try {
					message = JSON.parse(raw.toString())
				} catch (err) {
					this.logger.warn('Error parsing Websocket data: ' + err)
				}
				if (message) {
					const msgId = message.msgId
					this.handleWebSocketMessage(message)
						.then((response) => {
							if (response.code === 200) {
								this.sendMessage(ws, {
									type: SendWSMessageType.REPLY,
									replyTo: msgId,
									error: undefined,
									result: response,
								})
							} else {
								this.sendMessage(ws, {
									type: SendWSMessageType.REPLY,
									replyTo: msgId,
									error: `[${response.code}] ${response.body}`,
									result: response,
								})
							}
						})
						.catch((err) => {
							this.logger.warn(err)

							this.sendMessage(ws, {
								type: SendWSMessageType.REPLY,
								replyTo: msgId,
								error: `${err}`,
								result: undefined,
							})
						})
				}
			}

			ws.once('close', () => {
				const index = this.connectedClients.findIndex((o) => o.connectionId === connectionId)
				if (index !== -1) {
					const client = this.connectedClients[index]
					clearInterval(client.statusInterval)

					this.connectedClients.splice(index, 1)
				} else {
					this.logger.warn(`Could not find websocket client on close for connection "${connectionId}"`)
				}

				// Remove listeners:
				ws.off('message', onMessage)

				this.logger.debug(`Connection "${connectionId}" from ${remoteAddress} was closed`)
			})
			// Add listeners:
			ws.on('message', onMessage)

			// Send initial status:
			this.sendStatusToClient(ws)
		})
		this.logger.info(`Websocket server listening on port ${wsPort}`)
	}

	private async unknownCommandReply(): Promise<APIResponseBase> {
		return { code: 400, body: 'Unknown command' }
	}
	private async apiPlayURL(
		windowId: unknown | string,
		url: unknown | string,
		jsCode: unknown | string | undefined
	): Promise<ReceiveWSMessageResponse<ReceiveWSMessageType.PLAYURL>> {
		if (typeof windowId !== 'string') {
			return { code: 400, body: 'windowId must be a string' }
		} else if (typeof url !== 'string') {
			return { code: 400, body: 'url must be a string' }
		} else {
			const window = this.windowsHelper.getWindow(windowId)
			if (!window) return { code: 404, body: `windowId ${windowId} not found` }

			await window.playURL(url)

			if (jsCode && typeof jsCode === 'string') {
				await window.executeJavascript(jsCode)
			}
			return { code: 200, body: 'ok' }
		}
	}
	private async apiRestart(
		windowId: unknown | string
	): Promise<ReceiveWSMessageResponse<ReceiveWSMessageType.RESTART>> {
		if (typeof windowId !== 'string') {
			return { code: 400, body: 'windowId must be a string' }
		} else {
			if (windowId === '$all') {
				// "$all" is a magic token to restart all windows
				await Promise.all(this.windowsHelper.getAllWindows().map(async (w) => w.window.restart()))
			} else {
				const window = this.windowsHelper.getWindow(windowId)
				if (!window) return { code: 404, body: `windowId ${windowId} not found` }

				await window.restart()
			}
			return { code: 200, body: 'ok' }
		}
	}
	private async apiStop(windowId: unknown | string): Promise<ReceiveWSMessageResponse<ReceiveWSMessageType.STOP>> {
		if (typeof windowId !== 'string') {
			return { code: 400, body: 'windowId must be a string' }
		} else {
			const window = this.windowsHelper.getWindow(windowId)
			if (!window) return { code: 404, body: `windowId ${windowId} not found` }

			await window.stop()
			return { code: 200, body: 'ok' }
		}
	}
	private async apiExecute(
		windowId: unknown | string,
		jsCode: unknown | string
	): Promise<ReceiveWSMessageResponse<ReceiveWSMessageType.EXECUTE>> {
		if (typeof windowId !== 'string') {
			return { code: 400, body: 'windowId must be a string' }
		} else if (typeof jsCode !== 'string') {
			return { code: 400, body: 'jsCode must be a string' }
		} else {
			const window = this.windowsHelper.getWindow(windowId)
			if (!window) return { code: 404, body: `windowId ${windowId} not found` }

			await window.executeJavascript(jsCode)
			return { code: 200, body: 'ok' }
		}
	}
	private async apiList(): Promise<ReceiveWSMessageResponse<ReceiveWSMessageType.LIST>> {
		const windows = this.windowsHelper.getAllWindows()

		return {
			code: 200,
			body: windows.map((w) => ({
				id: w.id,
				url: w.window.url,
				actualUrl: w.window.getURL(),
				statusCode: w.window.status.statusCode,
				statusMessage: w.window.status.message,
			})),
		}
	}

	private async handleWebSocketMessage<M extends ReceiveWSMessageAny>(
		message: ReceiveWSMessageAny
	): Promise<ReceiveWSMessageResponse<M['type']>> {
		if (!this.config) throw new Error('this.config not set!')

		if (this.config.apiKey && this.config.apiKey !== message.apiKey) {
			this.logger.warn(`[403] ${message.type}`)
			return {
				code: 403,
				body: 'apiKey missing or is invalid.',
			}
		}

		this.logger.debug(`Received message: ${JSON.stringify(message)}`)

		if (message.type === ReceiveWSMessageType.PLAYURL) {
			return this.apiPlayURL(message.windowId, message.url, message.jsCode)
		} else if (message.type === ReceiveWSMessageType.RESTART) {
			return this.apiRestart(message.windowId)
		} else if (message.type === ReceiveWSMessageType.STOP) {
			return this.apiStop(message.windowId)
		} else if (message.type === ReceiveWSMessageType.EXECUTE) {
			return this.apiExecute(message.windowId, message.jsCode)
		} else if (message.type === ReceiveWSMessageType.LIST) {
			return this.apiList()
		} else {
			return this.unknownCommandReply()
		}
	}
	private sendMessage(ws: WebSocket, msg: SendWSMessageAny) {
		ws.send(JSON.stringify(msg))
	}
	private broadcastStatusToClients = rateLimitAndDoLater(
		() => {
			// Broadcast status to all clients
			for (const client of this.connectedClients) {
				this.sendStatusToClient(client.ws)
			}
		},
		STATUS_SETTLE_TIME,
		(err) => {
			this.logger.error(err)
		}
	)
	private sendStatusToClient(ws: WebSocket) {
		this.sendMessage(ws, {
			type: SendWSMessageType.STATUS,
			status: this.status,
		})
	}
}

function firstInArray<T>(v: T | T[]): T {
	if (Array.isArray(v)) return v[0]
	else return v
}

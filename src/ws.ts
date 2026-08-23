import { Adapter, Context, Dict, HTTP, Logger, Schema, Time, Universal } from 'koishi'
import { WebSocketLayer } from '@koishijs/plugin-server'
import { OneBotBot } from './bot'
import { dispatchSession, Response, TimeoutError } from './utils'

interface SharedConfig<T = 'ws' | 'ws-reverse'> {
  protocol: T
  responseTimeout?: number
}

export class WsClient<C extends Context = Context> extends Adapter.WsClient<C, OneBotBot<C, OneBotBot.BaseConfig & WsClient.Options>> {
  accept(socket: Universal.WebSocket): void {
    accept(socket, this.bot)
  }

  prepare() {
    const { token, endpoint } = this.bot.config
    const http = this.ctx.http.extend(this.bot.config)
    if (token) http.config.headers.Authorization = `Bearer ${token}`
    return http.ws(endpoint)
  }
}

export namespace WsClient {
  export interface Options extends SharedConfig<'ws'>, HTTP.Config, Adapter.WsClientConfig {}

  export const Options: Schema<Options> = Schema.intersect([
    Schema.object({
      protocol: Schema.const('ws').required(process.env.KOISHI_ENV !== 'browser'),
      responseTimeout: Schema.natural().role('time').default(Time.minute).description('等待响应的时间 (单位为毫秒)。'),
    }).description('连接设置'),
    HTTP.createConfig(true),
    Adapter.WsClientConfig,
  ])
}

const kSocket = Symbol('socket')

export class WsServer<C extends Context> extends Adapter<C, OneBotBot<C, OneBotBot.BaseConfig & WsServer.Options>> {
  static inject = ['server']

  public logger: Logger
  public wsServer?: WebSocketLayer

  constructor(ctx: C, bot: OneBotBot<C>) {
    super(ctx)
    this.logger = ctx.logger('onebot')

    const { path = '/onebot' } = bot.config as WsServer.Options
    this.wsServer = ctx.server.ws(path, (socket, { headers }) => {
      this.logger.debug('connected with', headers)
      if (headers['x-client-role'] !== 'Universal') {
        return socket.close(1008, 'invalid x-client-role')
      }
      const selfId = headers['x-self-id'].toString()
      const bot = this.bots.find(bot => bot.selfId === selfId)
      if (!bot) return socket.close(1008, 'invalid x-self-id')

      bot[kSocket] = socket
      accept(socket as Universal.WebSocket, bot)
    })

    ctx.on('dispose', () => {
      this.logger.debug('ws server closing')
      this.wsServer.close()
    })
  }

  async disconnect(bot: OneBotBot<C>) {
    bot[kSocket]?.close()
    bot[kSocket] = null
  }
}

export namespace WsServer {
  export interface Options extends SharedConfig<'ws-reverse'> {
    path?: string
  }

  export const Options: Schema<Options> = Schema.object({
    protocol: Schema.const('ws-reverse').required(process.env.KOISHI_ENV === 'browser'),
    path: Schema.string().description('服务器监听的路径。').default('/onebot'),
    responseTimeout: Schema.natural().role('time').default(Time.minute).description('等待响应的时间 (单位为毫秒)。'),
  }).description('连接设置')
}

let counter = 0
const listeners: Record<number, (response: Response) => void> = {}

interface PendingRequest {
  reject: (error: Error) => void
  dispose: () => void
}

export function accept<C extends Context>(socket: Universal.WebSocket, bot: OneBotBot<C, OneBotBot.Config>) {
  const responseTimeout = 'responseTimeout' in bot.config ? bot.config.responseTimeout : Time.minute
  const pending = new Map<number, PendingRequest>()
  let closed = false

  const request = (action: string, params: Dict): Promise<Response> => {
    if (closed) return Promise.reject(new Error('OneBot WebSocket connection has closed'))
    const data = { action, params, echo: ++counter }
    return new Promise<Response>((resolve, reject) => {
      // 超时后主动清理，避免 pending 和全局 listeners 一直残留
      const dispose = bot.ctx.setTimeout(() => {
        pending.delete(data.echo)
        delete listeners[data.echo]
        reject(new TimeoutError(params, action))
      }, responseTimeout)
      pending.set(data.echo, { reject, dispose })
      listeners[data.echo] = (response) => {
        pending.delete(data.echo)
        dispose()
        delete listeners[data.echo]
        resolve(response)
      }
      try {
        socket.send(JSON.stringify(data))
      } catch (error) {
        pending.delete(data.echo)
        dispose()
        delete listeners[data.echo]
        reject(error)
      }
    })
  }

  let disposeContext: () => void = () => {}
  const cleanup = () => {
    if (closed) return
    closed = true

    // 断开时立即拒绝当前连接所有未完成的请求
    const error = new Error('OneBot WebSocket connection has closed')
    for (const [echo, pendingRequest] of pending) {
      delete listeners[echo]
      pendingRequest.dispose()
      pendingRequest.reject(error)
    }
    pending.clear()

    // 只清理仍属于当前连接的 _request，避免旧连接关闭时误删新连接的状态
    if (bot.internal._request === request) {
      bot.internal._request = () => Promise.reject(error)
      // WsClient 的重连由基类管理，close 时不要覆盖其状态；反向 WS 没有基类重连，仍要置为离线
      if (bot.config.protocol === 'ws-reverse') bot.offline()
    }
    disposeContext()
  }
  disposeContext = bot.ctx.on('dispose', cleanup)

  socket.addEventListener('message', (event) => {
    if (closed) return
    let parsed: any
    const data = event.data.toString()
    try {
      parsed = JSON.parse(data)
    } catch (error) {
      return bot.logger.warn('cannot parse message', data)
    }

    if ('post_type' in parsed) {
      bot.logger.debug('[receive] %o', parsed)
      dispatchSession(bot, parsed)
    } else if (parsed.echo in listeners) {
      listeners[parsed.echo](parsed)
      delete listeners[parsed.echo]
    }
  })

  socket.addEventListener('close', cleanup)

  bot.internal._request = request
  bot.initialize()
}

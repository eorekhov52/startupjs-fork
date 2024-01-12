import sockjs from 'sockjs'
import WebSocket from 'ws'
import crypto from 'crypto'
import createSockJsStream from './createSockJsStream.js'
import createWebSocketStream from './createWebSocketStream.js'

const defaultServerOptions = {
  session: null,
  base: '/channel',
  noPing: false,
  pingInterval: 30000
}

export default function (backend, serverOptions = {}) {
  serverOptions = { ...defaultServerOptions, ...serverOptions }

  // ws-module specific options
  serverOptions.path = serverOptions.base
  serverOptions.noServer = true

  const echo = sockjs.createServer({ prefix: '/channel', transports: ['xhr-polling'] })

  let syncTempConnectSession
  let syncReq
  echo.on('connection', function (client) {
    client.id = crypto.randomBytes(16).toString('hex')

    let rejected = false
    let rejectReason

    function reject (reason) {
      rejected = true
      if (reason) rejectReason = reason
    }

    client.connectSession = syncTempConnectSession
    client.session = syncTempConnectSession
    syncTempConnectSession = undefined

    const req = syncReq
    syncReq = undefined
    client.upgradeReq = req

    backend.emit('client', client, reject)
    if (rejected) {
      // Tell the client to stop trying to connect
      client.close(1001, rejectReason)
      return
    }

    const stream = createSockJsStream(client)
    doneInitialization(backend, stream, req, client.connectSession)
  })

  const middleware = (req, res, next) => {
    if (/\/channel/.test(req.url)) {
      if (serverOptions.session) {
        serverOptions.session(req, {}, next)
      } else {
        next()
      }
      function next () {
        syncTempConnectSession = req.session
        syncReq = req
        echo.handler(req, res)
      }
    } else {
      next()
    }
  }

  const wss = new WebSocket.Server(serverOptions)

  wss.on('connection', function (client) {
    client.id = crypto.randomBytes(16).toString('hex')

    // Some proxy drop out long connections
    // so do ping periodically to prevent this
    // interval = 30s by default
    if (!serverOptions.noPing) {
      client.timer = setInterval(function () {
        if (client.readyState === WebSocket.OPEN) {
          client.ping()
        } else {
          clearInterval(client.timer)
        }
      }, serverOptions.pingInterval)
    }

    let rejected = false
    let rejectReason

    function reject (reason) {
      rejected = true
      if (reason) rejectReason = reason
    }

    if (client.upgradeReq.session) client.connectSession = client.upgradeReq.session

    backend.emit('client', client, reject)
    if (rejected) {
      // Tell the client to stop trying to connect
      client.close(1001, rejectReason)
      return
    }

    const stream = createWebSocketStream(client)
    doneInitialization(backend, stream, client.upgradeReq)
  })

  function upgrade (req, socket, upgradeHead) {
    // copy upgradeHead to avoid retention of large slab buffers used in node core
    const head = Buffer.alloc(upgradeHead.length)
    upgradeHead.copy(head)

    if (serverOptions.session) {
      // https://github.com/expressjs/session/pull/57
      if (!req.originalUrl) req.originalUrl = req.url
      serverOptions.session(req, {}, next)
    } else {
      next()
    }

    function next () {
      wss.handleUpgrade(req, socket, head, function (client) {
        wss.emit('connection' + req.url, client)
        wss.emit('connection', client)
      })
    }
  }

  if (serverOptions.session) {
    backend.use('connect', function (shareRequest, next) {
      const req = shareRequest.req
      const agent = shareRequest.agent

      if (!agent.connectSession && req && req.session) {
        agent.connectSession = req.session
      }

      next()
    })
  }

  return { upgrade, middleware, wss }
}

function doneInitialization (backend, stream, request, session) {
  backend.on('connect', function (data) {
    const agent = data.agent
    if (session) {
      agent.connectSession = session
    } else if (request.session) {
      agent.connectSession = request.session
    }
    backend.emit('share agent', agent, stream)
  })

  backend.listen(stream, request)
}

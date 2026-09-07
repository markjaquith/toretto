const HOST = '127.51.68.120'
const BASE = `wss://${HOST}/3dconnexion`
const READ = new Map(Object.entries({
  'view.affine': 'getViewMatrix', 'view.extents': 'getViewExtents',
  'model.extents': 'getModelExtents', 'pivot.position': 'getPivotPosition',
  coordinateSystem: 'getCoordinateSystem', 'views.front': 'getFrontView',
  'view.perspective': 'getPerspective', 'view.rotatable': 'getViewRotatable',
  'selection.empty': 'getSelectionEmpty', 'model.unitsToMeters': 'getUnitsToMeters',
  'view.constructionPlane': 'getConstructionPlane', 'model.floorPlane': 'getFloorPlane',
  'hit.lookat': 'getLookAt', 'frame.timingSource': 'getFrameTimingSource',
  'frame.time': 'getFrameTime',
}))
const WRITE = new Map(Object.entries({
  transaction: 'setTransaction', 'view.affine': 'setViewMatrix',
  'view.extents': 'setViewExtents', 'hit.lookfrom': 'setLookFrom',
  'hit.direction': 'setLookDirection', 'hit.aperture': 'setLookAperture',
  'hit.selectionOnly': 'setSelectionOnly',
}))
const identifier = value => (typeof value === 'string' && value.length > 0 &&
  /^[a-zA-Z0-9_-]+$/.test(value)) || (Number.isSafeInteger(value) && value >= 0)
const callId = value => typeof value === 'string' && value.length > 0

// Independent WAMP v1 subset for the installed 3DxNLServer. No remote code loads.
export class SpaceMouseTransport {
  constructor(client, environment = globalThis) {
    this.client = client
    this.environment = environment
    this.state = 'idle'
    this.pending = new Map()
    this.connexion = null
    this.controller = null
  }

  connect() {
    if (this.state !== 'idle') return 1
    this.state = 'discovering'
    this.abort = new AbortController()
    void this.discover()
    return 1
  }

  async discover() {
    try {
      const response = await this.environment.fetch(`https://${HOST}:8181/3dconnexion/nlproxy`, {
        signal: this.abort.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
        redirect: 'error', mode: 'cors',
      })
      if (this.state === 'closed') return
      if (!response.ok) throw new Error()
      const data = await response.json()
      if (this.state === 'closed') return
      if (!Number.isInteger(data?.port) || data.port < 1 || data.port > 65535) throw new Error()
      const socket = new this.environment.WebSocket(`wss://${HOST}:${data.port}`, 'wamp')
      this.socket = socket
      this.state = 'handshake'
      socket.onopen = () => {
        if (socket.protocol !== 'wamp') this.fail('SpaceMouse service did not negotiate the WAMP protocol.')
      }
      socket.onmessage = event => {
        if (this.state === 'closed') return
        try { this.receive(event.data) }
        catch { this.fail('SpaceMouse sent an invalid protocol message.') }
      }
      socket.onerror = () => this.fail('SpaceMouse connection failed. Check 3DxWare and local-network access.')
      socket.onclose = () => this.fail('SpaceMouse disconnected. Reconnect to try again.')
    } catch {
      this.fail('SpaceMouse discovery failed. Check 3DxWare, local-network access, and its TLS certificate.')
    }
  }

  send(message) {
    if (this.state === 'closed' || this.socket?.readyState !== 1) throw new Error('SpaceMouse is not connected.')
    this.socket.send(JSON.stringify(message))
  }

  call(procedure, ...args) {
    return new Promise((resolve, reject) => {
      if (this.state !== 'connected') {
        reject(new Error('SpaceMouse is not connected.'))
        return
      }
      if (this.pending.size >= 128) {
        this.fail('SpaceMouse service has too many unanswered requests. Reconnect to try again.')
        reject(new Error('SpaceMouse request limit reached.'))
        return
      }
      const id = globalThis.crypto.randomUUID()
      const timer = setTimeout(() => {
        this.fail('SpaceMouse service response timed out. Reconnect to try again.')
      }, 5000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send([2, id, procedure, ...args]) }
      catch {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('SpaceMouse request could not be sent.'))
      }
    })
  }

  receive(text) {
    if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 65536) throw new Error()
    const message = JSON.parse(text)
    if (!Array.isArray(message)) throw new Error()
    const [type, id] = message
    if (type === 0) {
      if (this.state !== 'handshake' || message.length < 2 || message.length > 4 ||
          !callId(id) || (message.length >= 3 && message[2] !== 1) ||
          (message.length === 4 && typeof message[3] !== 'string')) throw new Error()
      const origin = this.environment.location?.origin
      const identity = typeof origin === 'string' && /^https?:\/\/[^/?#]+$/.test(origin)
        ? `${origin}/` : 'urn:toretto:view'
      this.send([1, '3dx_rpc', `${BASE}#`])
      this.send([1, '3dconnexion', BASE])
      this.send([1, 'self', identity])
      this.state = 'connected'
      this.client.onConnect?.()
      return
    }
    if (this.state !== 'connected') throw new Error()
    if (type === 3 || type === 4) {
      if (!callId(id) || (type === 3 && message.length !== 3) ||
          (type === 4 && (message.length < 4 || message.length > 5 ||
            typeof message[2] !== 'string' || typeof message[3] !== 'string'))) throw new Error()
      const pending = this.pending.get(id)
      if (!pending) throw new Error()
      clearTimeout(pending.timer)
      this.pending.delete(id)
      if (type === 3) pending.resolve(message[2])
      else pending.reject(new Error('SpaceMouse service rejected a request.'))
      return
    }
    if (type !== 8 || message.length !== 3 || !callId(id)) throw new Error()
    const request = message[2]
    if (!Array.isArray(request) || request[0] !== 2 || !callId(request[1]) ||
        !['self:read', 'self:update'].includes(request[2]) ||
        request.length !== (request[2] === 'self:read' ? 5 : 6) ||
        !(typeof request[3] === 'string' || Number.isSafeInteger(request[3])) ||
        typeof request[4] !== 'string') throw new Error()
    // The service can publish before creation completes. Only subscribed topics dispatch.
    // WAMP prefixes concatenate directly, so recognize the exact CURIE and full URI.
    if (this.controller === null ||
        ![`3dconnexion:3dcontroller/${this.controller}`, `${BASE}3dcontroller/${this.controller}`].includes(id)) return
    const [, rpcId, procedure, , property, value] = request
    let method = procedure === 'self:read' ? READ.get(property) : WRITE.get(property)
    if (procedure === 'self:update' && property === 'motion') {
      if (typeof value !== 'boolean') throw new Error()
      method = value ? 'onStartMotion' : 'onStopMotion'
    }
    if (!method || typeof this.client[method] !== 'function') {
      this.send([4, rpcId, `${BASE}#generic`, 'unsupported property'])
      return
    }
    let result
    try { result = this.client[method](...(procedure === 'self:read' ? [] : [value])) }
    catch {
      if (this.state !== 'closed') this.send([4, rpcId, `${BASE}#generic`, 'property callback failed'])
      return
    }
    if (this.state !== 'closed') this.send([3, rpcId, result ?? null])
  }

  async create3dmouse(_viewport, _name = 'Toretto') {
    if (this.state !== 'connected' || this.creating) return
    this.creating = true
    try {
      const result = await this.call('3dx_rpc:create', '3dconnexion:3dmouse', '0.7.0')
      if (this.state !== 'connected') return
      if (!identifier(result?.connexion)) throw new Error()
      this.connexion = result.connexion
      const controller = await this.call('3dx_rpc:create', '3dconnexion:3dcontroller', this.connexion,
        { version: 0.7, name: 'Toretto', rowMajorOrder: false })
      if (this.state !== 'connected') return
      if (!identifier(controller?.instance)) throw new Error()
      this.send([5, `3dconnexion:3dcontroller/${controller.instance}`])
      this.controller = controller.instance
      this.client.on3dmouseCreated?.()
    } catch {
      this.fail('SpaceMouse controller creation failed.')
    }
  }

  async update3dcontroller(properties) {
    if (this.state !== 'connected' || this.controller === null) return
    try { await this.call('3dx_rpc:update', `3dconnexion:3dcontroller/${this.controller}`, properties) }
    catch { this.fail('SpaceMouse controller update failed.') }
  }

  focus() { return this.update3dcontroller({ focus: true }) }
  blur() { return this.update3dcontroller({ focus: false }) }

  fail(message) {
    if (this.state === 'closed') return
    this.close(false)
    try { this.client.onDisconnect?.(message) } catch { /* The transport is already terminal. */ }
  }

  close(graceful = true) {
    if (this.state === 'closed') return
    const socket = this.socket
    this.state = 'closed'
    this.abort?.abort()
    // Fire-and-forget deletion only for resources confirmed by the service.
    if (graceful && socket?.readyState === 1) {
      for (const [kind, id] of [['3dcontroller', this.controller], ['3dmouse', this.connexion]]) {
        if (id === null) continue
        try { socket.send(JSON.stringify([2, globalThis.crypto.randomUUID(), '3dx_rpc:delete', `3dconnexion:${kind}/${id}`])) }
        catch { break }
      }
    }
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error('SpaceMouse connection closed.'))
    }
    this.pending.clear()
    if (!socket) return
    socket.onmessage = socket.onerror = socket.onclose = socket.onopen = null
    try { socket.close() }
    catch {
      // Some implementations cannot close CONNECTING sockets until they open.
      socket.onopen = () => {
        socket.onopen = null
        try { socket.close() } catch { /* Best effort; all message handlers are detached. */ }
      }
    }
  }
}

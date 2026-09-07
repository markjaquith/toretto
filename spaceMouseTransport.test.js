import test from 'node:test'
import assert from 'node:assert/strict'
import { SpaceMouseTransport } from './spaceMouseTransport.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

function harness(client = {}) {
  const discovery = deferred(), sockets = [], requests = [], errors = []
  let connected = 0, created = 0
  class Socket {
    readyState = 0
    sent = []
    constructor(url, protocol) { this.url = url; this.protocol = protocol; sockets.push(this) }
    send(text) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(text)) }
    close() { this.readyState = 3; this.onclose?.() }
    message(value) { this.onmessage?.({ data: JSON.stringify(value) }) }
    welcome() { this.readyState = 1; this.message([0, 'session', 1, '3DxNLServer']) }
    result(value) { this.message([3, this.sent.at(-1)[1], value]) }
  }
  const transport = new SpaceMouseTransport({
    onConnect() { connected++ }, on3dmouseCreated() { created++ },
    onDisconnect(message) { errors.push(message) }, ...client,
  }, {
    fetch(url, options) { requests.push({ url, options }); return discovery.promise },
    WebSocket: Socket,
    location: { origin: 'https://toretto.test', href: 'https://toretto.test/private?secret=xyz' },
  })
  return { transport, discovery, sockets, requests, errors,
    get connected() { return connected }, get created() { return created },
    async handshake() {
      assert.equal(transport.connect(), 1)
      discovery.resolve({ ok: true, json: async () => ({ port: 12345 }) })
      await flush()
      sockets[0].welcome()
      return sockets[0]
    },
    async controller() {
      const socket = await this.handshake()
      const promise = transport.create3dmouse({ focus() { assert.fail('no autofocus') } })
      socket.result({ connexion: 'connexion-1' })
      await flush()
      socket.result({ instance: 'controller-1' })
      await promise
      return socket
    },
  }
}

test('fixed discovery security options and origin-only WAMP prefixes', async () => {
  const h = harness(), s = await h.handshake()
  assert.equal(h.requests[0].url, 'https://127.51.68.120:8181/3dconnexion/nlproxy')
  const { signal, ...options } = h.requests[0].options
  assert.ok(signal instanceof AbortSignal)
  assert.deepEqual(options, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', mode: 'cors' })
  assert.equal(s.url, 'wss://127.51.68.120:12345')
  assert.equal(s.protocol, 'wamp')
  assert.deepEqual(s.sent, [[1, '3dx_rpc', 'wss://127.51.68.120/3dconnexion#'],
    [1, '3dconnexion', 'wss://127.51.68.120/3dconnexion'], [1, 'self', 'https://toretto.test/']])
  assert.equal(h.connected, 1)
  h.transport.close()
})

test('close aborts discovery and suppresses late fetch and JSON continuations', async () => {
  for (const duringJSON of [false, true]) {
    const h = harness(), json = deferred()
    h.transport.connect()
    if (duringJSON) {
      h.discovery.resolve({ ok: true, json: () => json.promise })
      await flush()
    }
    h.transport.close()
    h.discovery.resolve({ ok: true, json: async () => ({ port: 12345 }) })
    json.resolve({ port: 12345 })
    await flush()
    assert.equal(h.requests[0].options.signal.aborted, true)
    assert.equal(h.sockets.length, 0)
    assert.deepEqual(h.errors, [])
  }
})

test('invalid discovery ports never select another host or open a socket', async () => {
  for (const port of [0, -1, 65536, 1.1, '12345', '443/evil', '443@evil.test', null, {}, true]) {
    const h = harness()
    h.transport.connect()
    h.discovery.resolve({ ok: true, json: async () => ({ port }) })
    await flush()
    assert.equal(h.sockets.length, 0)
    assert.equal(h.errors.length, 1)
  }
})

test('handshake cancellation detaches handlers, including a CONNECTING close exception', async () => {
  const h = harness()
  h.transport.connect()
  h.discovery.resolve({ ok: true, json: async () => ({ port: 12345 }) })
  await flush()
  const s = h.sockets[0], lateMessage = s.onmessage
  s.close = () => { if (s.readyState === 0) throw new Error(); s.readyState = 3 }
  h.transport.close()
  lateMessage({ data: '[0,"late",1]' })
  s.readyState = 1
  s.onopen()
  assert.equal(s.readyState, 3)
  assert.equal(h.connected, 0)
  assert.deepEqual(s.sent, [])
})

test('creation wire sequence, focus, and graceful resource deletion', async () => {
  const h = harness(), s = await h.controller()
  assert.deepEqual(s.sent[3].slice(2), ['3dx_rpc:create', '3dconnexion:3dmouse', '0.7.0'])
  assert.match(s.sent[3][1], /^[0-9a-f-]{36}$/)
  assert.deepEqual(s.sent[4].slice(2), ['3dx_rpc:create', '3dconnexion:3dcontroller', 'connexion-1',
    { version: 0.7, name: 'Toretto', rowMajorOrder: false }])
  assert.deepEqual(s.sent[5], [5, '3dconnexion:3dcontroller/controller-1'])
  assert.equal(h.created, 1)
  for (const [method, focus] of [['focus', true], ['blur', false]]) {
    const promise = h.transport[method]()
    assert.deepEqual(s.sent.at(-1).slice(2), ['3dx_rpc:update', '3dconnexion:3dcontroller/controller-1', { focus }])
    s.result(null)
    await promise
  }
  h.transport.close()
  assert.deepEqual(s.sent.slice(-2).map(m => m.slice(2)), [
    ['3dx_rpc:delete', '3dconnexion:3dcontroller/controller-1'],
    ['3dx_rpc:delete', '3dconnexion:3dmouse/connexion-1'],
  ])
  const count = s.sent.length
  await h.transport.focus()
  h.transport.close()
  assert.equal(s.sent.length, count)
})

test('cancellation at either creation await prevents subscription and callbacks', async () => {
  for (const stage of [1, 2]) {
    for (const resolved of [false, true]) {
      const h = harness(), s = await h.handshake()
      const creation = h.transport.create3dmouse(null)
      if (stage === 2) { s.result({ connexion: 'c' }); await flush() }
      if (resolved) s.result(stage === 1 ? { connexion: 'c' } : { instance: 'i' })
      h.transport.close()
      const count = s.sent.length
      await creation
      assert.equal(s.sent.length, count)
      assert.equal(h.created, 0)
      assert.deepEqual(h.errors, [])
      assert.equal(h.transport.pending.size, 0)
    }
  }
})

test('allowlisted event callbacks, no-op returns, unsupported properties, and exact topic', async () => {
  const writes = []
  const h = harness({ getViewMatrix: () => [1, 2], setLookFrom: value => { writes.push(value) } })
  const s = await h.controller()
  const event = (procedure, property, ...args) => s.message([8, '3dconnexion:3dcontroller/controller-1',
    [2, 'callback', procedure, 'controller-1', property, ...args]])
  event('self:read', 'view.affine')
  assert.deepEqual(s.sent.at(-1), [3, 'callback', [1, 2]])
  event('self:update', 'hit.lookfrom', [3, 4])
  assert.deepEqual(writes, [[3, 4]])
  assert.deepEqual(s.sent.at(-1), [3, 'callback', null])
  for (const property of ['constructor', '__proto__', 'unknown', 'view.extents']) {
    event('self:read', property)
    assert.deepEqual(s.sent.at(-1), [4, 'callback', 'wss://127.51.68.120/3dconnexion#generic', 'unsupported property'])
  }
  const count = s.sent.length
  s.message([8, '3dconnexion:3dcontroller/other', [2, 'x', 'self:read', '', 'view.affine']])
  assert.equal(s.sent.length, count)
  assert.equal(h.errors.length, 0)
  h.transport.close()
})

test('RPC failures are terminal, sanitized, and never send on a dead socket', async () => {
  for (const creation of [true, false]) {
    const h = harness(), s = creation ? await h.handshake() : await h.controller()
    const operation = creation ? h.transport.create3dmouse(null) : h.transport.focus()
    s.message([4, s.sent.at(-1)[1], 'private-uri', 'secret page/device data'])
    await operation
    const count = s.sent.length
    s.onerror?.()
    await h.transport.blur()
    assert.equal(s.sent.length, count)
    assert.equal(h.errors.length, 1)
    assert.doesNotMatch(h.errors[0], /private|secret/)
  }
  const h = harness(), s = await h.controller()
  const operation = h.transport.focus(), error = s.onerror, close = s.onclose
  s.readyState = 3
  close()
  error()
  await operation
  assert.equal(h.errors.length, 1)
})

test('malformed, oversized, and invalid RPC results fail safely', async () => {
  for (const data of ['{', '{}', '[99]', '[3,"unknown",null]', '[4,"x"]',
    '[0,"duplicate",1]', ' '.repeat(65537), '[8,"topic",{}]']) {
    const h = harness(), s = await h.handshake()
    s.onmessage({ data })
    assert.equal(h.errors.length, 1)
    assert.equal(s.readyState, 3)
  }
  for (const result of [null, {}, { connexion: '../private' }]) {
    const h = harness(), s = await h.handshake()
    const creation = h.transport.create3dmouse(null)
    s.result(result)
    await creation
    assert.equal(h.errors.length, 1)
  }
})

test('all supported properties dispatch explicitly, including expanded WAMP topics', async () => {
  const reads = {
    'view.affine': 'getViewMatrix', 'view.extents': 'getViewExtents',
    'model.extents': 'getModelExtents', 'pivot.position': 'getPivotPosition',
    coordinateSystem: 'getCoordinateSystem', 'views.front': 'getFrontView',
    'view.perspective': 'getPerspective', 'view.rotatable': 'getViewRotatable',
    'selection.empty': 'getSelectionEmpty', 'model.unitsToMeters': 'getUnitsToMeters',
    'view.constructionPlane': 'getConstructionPlane', 'model.floorPlane': 'getFloorPlane',
    'hit.lookat': 'getLookAt', 'frame.timingSource': 'getFrameTimingSource', 'frame.time': 'getFrameTime',
  }
  const writes = { transaction: 'setTransaction', 'view.affine': 'setViewMatrix',
    'view.extents': 'setViewExtents', 'hit.lookfrom': 'setLookFrom',
    'hit.direction': 'setLookDirection', 'hit.aperture': 'setLookAperture',
    'hit.selectionOnly': 'setSelectionOnly' }
  const calls = [], client = {}
  for (const method of Object.values(reads)) client[method] = () => method
  for (const method of [...Object.values(writes), 'onStartMotion', 'onStopMotion']) {
    client[method] = value => { calls.push([method, value]) }
  }
  const h = harness(client), s = await h.controller()
  const event = (...args) => s.message([8, 'wss://127.51.68.120/3dconnexion3dcontroller/controller-1',
    [2, 'callback', ...args]])
  for (const [property, method] of Object.entries(reads)) {
    event('self:read', 1, property)
    assert.deepEqual(s.sent.at(-1), [3, 'callback', method])
  }
  for (const [property, method] of Object.entries(writes)) {
    event('self:update', 1, property, 42)
    assert.deepEqual(calls.at(-1), [method, 42])
    assert.deepEqual(s.sent.at(-1), [3, 'callback', null])
  }
  event('self:update', 1, 'motion', true)
  event('self:update', 1, 'motion', false)
  assert.deepEqual(calls.slice(-2), [['onStartMotion', true], ['onStopMotion', false]])
  h.transport.close()
})

test('discovery failures and rejected protocol negotiation report once', async () => {
  for (const failure of ['fetch', 'status', 'json']) {
    const h = harness()
    h.transport.connect()
    if (failure === 'fetch') h.discovery.reject(new Error('private data'))
    else h.discovery.resolve({ ok: failure !== 'status', json: async () => { throw new Error('private data') } })
    await flush()
    assert.equal(h.errors.length, 1)
    assert.doesNotMatch(h.errors[0], /private data/)
    assert.equal(h.sockets.length, 0)
  }
  const h = harness(), s = await h.handshake()
  s.protocol = 'other'
  s.onopen()
  assert.equal(h.errors.length, 1)
  assert.equal(s.readyState, 3)
})

test('callback exceptions produce sanitized errors; callback cleanup prevents replies', async () => {
  const h = harness({ getViewMatrix() { throw new Error('private data') } })
  const s = await h.controller()
  const request = [8, '3dconnexion:3dcontroller/controller-1', [2, 'callback', 'self:read', '', 'view.affine']]
  s.message(request)
  assert.deepEqual(s.sent.at(-1), [4, 'callback', 'wss://127.51.68.120/3dconnexion#generic', 'property callback failed'])
  h.transport.client.getViewMatrix = () => h.transport.close()
  s.message(request)
  assert.equal(s.sent.at(-1)[2], '3dx_rpc:delete')
  assert.deepEqual(h.errors, [])
})

test('hardware-shaped events before the controller response are ignored until subscribed', async () => {
  const selections = []
  const h = harness({ setSelectionOnly: value => { selections.push(value) } })
  const s = await h.handshake()
  const creation = h.transport.create3dmouse(null)
  s.result({ connexion: 'i9h0aMMFjALPEhFj' })
  await flush()
  const event = [8, '3dconnexion:3dcontroller/4762738729153',
    [2, 'JVZ-test-call', 'self:update', '', 'hit.selectionOnly', true]]
  const count = s.sent.length
  s.message(event)
  assert.equal(h.transport.controller, null)
  assert.equal(s.sent.length, count)
  assert.deepEqual(selections, [])
  assert.deepEqual(h.errors, [])
  assert.equal(h.created, 0)
  s.result({ instance: 4762738729153 })
  // Even a resolved creation RPC has not subscribed until its continuation runs.
  s.message(event)
  assert.deepEqual(selections, [])
  await creation
  assert.equal(h.created, 1)
  assert.equal(h.connected, 1)
  assert.deepEqual(s.sent.at(-1), [5, '3dconnexion:3dcontroller/4762738729153'])
  s.message(event)
  assert.deepEqual(selections, [true])
  assert.deepEqual(s.sent.at(-1), [3, 'JVZ-test-call', null])
  assert.deepEqual(h.errors, [])
  h.transport.close()
})

function trackTimers(t) {
  const timers = new Map()
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.equal(delay, 5000)
    const timer = {}
    timers.set(timer, callback)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', timer => { timers.delete(timer) })
  return timers
}

test('stalled frame updates are bounded and all pending work is cleaned up', async t => {
  const timers = trackTimers(t)
  for (const termination of ['timeout', 'limit', 'close', 'disconnect']) {
    const h = harness(), s = await h.controller()
    assert.equal(timers.size, 0)
    const updates = []
    for (let time = 0; time < 128; time++) {
      updates.push(h.transport.update3dcontroller({ frame: { time } }))
    }
    assert.equal(h.transport.pending.size, 128)
    assert.equal(timers.size, 128)
    const count = s.sent.length
    if (termination === 'timeout') timers.values().next().value()
    else if (termination === 'limit') updates.push(h.transport.update3dcontroller({ frame: { time: 129 } }))
    else if (termination === 'close') h.transport.close()
    else { s.readyState = 3; s.onclose() }
    await Promise.all(updates)
    assert.equal(h.transport.pending.size, 0)
    assert.equal(timers.size, 0)
    assert.equal(h.errors.length, termination === 'close' ? 0 : 1)
    if (termination === 'timeout') assert.match(h.errors[0], /timed out/)
    if (termination === 'limit') assert.match(h.errors[0], /too many unanswered/)
    assert.equal(s.sent.length, count + (termination === 'close' ? 2 : 0))
    const finalCount = s.sent.length
    await h.transport.update3dcontroller({ frame: { time: 130 } })
    assert.equal(s.sent.length, finalCount)
    assert.equal(timers.size, 0)
  }
})

test('creation timeouts clean both await stages without reporting creation', async t => {
  const timers = trackTimers(t)
  for (const stage of [1, 2]) {
    const h = harness(), s = await h.handshake()
    const creation = h.transport.create3dmouse(null)
    if (stage === 2) { s.result({ connexion: 'c' }); await flush() }
    assert.equal(timers.size, 1)
    timers.values().next().value()
    await creation
    assert.equal(timers.size, 0)
    assert.equal(h.transport.pending.size, 0)
    assert.equal(h.created, 0)
    assert.equal(h.errors.length, 1)
    assert.match(h.errors[0], /timed out/)
  }
})

test('RPC result, error, and send failure clear their response timers', async t => {
  const timers = trackTimers(t)
  for (const outcome of ['result', 'error', 'send']) {
    const h = harness(), s = await h.controller()
    assert.equal(timers.size, 0)
    if (outcome === 'send') s.send = () => { throw new Error('socket failed') }
    const update = h.transport.focus()
    if (outcome !== 'send') {
      assert.equal(timers.size, 1)
      if (outcome === 'result') s.result(null)
      else s.message([4, s.sent.at(-1)[1], 'error', 'rejected'])
      assert.equal(timers.size, 0)
    }
    await update
    assert.equal(timers.size, 0)
    assert.equal(h.transport.pending.size, 0)
    h.transport.close()
  }
})

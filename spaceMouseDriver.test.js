import test from 'node:test'
import assert from 'node:assert/strict'
import { connectSpaceMouseDriver } from './spaceMouseDriver.js'
import { createSpaceMouseCamera, applySpaceMouseTransaction } from './spaceMouse.js'
import { SpaceMouseTransport } from './spaceMouseTransport.js'

const readyMessage = '3Dconnexion driver connected. Focus the canvas and move the SpaceMouse to confirm input.'
const advisory = 'No SpaceMouse input received yet. Check the device and driver, focus the canvas, and move the cap. The connection remains open.'

function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const win = new EventTarget(), doc = new EventTarget(), viewport = new EventTarget()
  let enabled = true, focused = true, instance
  let state = { width: 1200, height: 800, fitScale: 0.5, zoom: 1, depth: 200,
    pan: { x: 10, y: 20 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }
  const changes = [], statuses = [], frames = new Map()
  let frameId = 0
  win.requestAnimationFrame = fn => { frames.set(++frameId, fn); return frameId }
  win.cancelAnimationFrame = id => frames.delete(id)
  doc.defaultView = win
  doc.hasFocus = () => focused
  doc.hidden = false
  doc.body = {}
  doc.activeElement = viewport
  viewport.ownerDocument = doc
  viewport.focus = () => { throw new Error('Must not steal DOM focus') }
  for (const target of [doc, viewport]) {
    for (const key of ['innerHTML', 'textContent', 'querySelector', 'elementFromPoint']) {
      Object.defineProperty(target, key, { get() { throw new Error('DOM content access') } })
    }
  }
  class Transport {
    constructor(client) { instance = this; this.client = client; this.updates = []; this.closes = 0 }
    connect() { return 1 }
    create3dmouse(element, name) {
      assert.equal(element, viewport)
      assert.equal(name, 'Toretto')
      this.creates = (this.creates || 0) + 1
    }
    update3dcontroller(value) { this.updates.push(value) }
    focus() { this.update3dcontroller({ focus: true }) }
    blur() { this.update3dcontroller({ focus: false }) }
    close() { this.closes++; this.client.onDisconnect('Recursive close') }
  }
  const cleanup = connectSpaceMouseDriver({ Transport, viewport, getCameraState: () => state,
    isEnabled: () => enabled, onCameraChange: update => {
      changes.push(update)
      state = { ...state, ...update }
    }, onStatus: value => statuses.push(value), ...options })
  t.after(cleanup)
  return { transport: instance, client: instance?.client, cleanup, doc, win, viewport, changes, statuses, frames,
    state: () => state, setState: update => { state = { ...state, ...update } },
    enable: value => { enabled = value }, focus: value => { focused = value },
    ready: () => { instance.client.onConnect(); instance.client.on3dmouseCreated() },
    tick: time => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(time)) },
  }
}

test('controller readiness is connected without claiming input, and metadata uses fresh state', t => {
  const h = setup(t)
  assert.equal(h.statuses[0].connecting, true)
  h.client.onConnect()
  assert.equal(h.statuses.length, 1)
  assert.equal(h.transport.creates, 1)
  h.client.on3dmouseCreated()
  assert.deepEqual(h.statuses.at(-1), { connected: true, connecting: false, message: readyMessage })
  assert.ok(h.transport.updates.some(value => value.frame?.timingSource === 1))
  h.setState({ depth: 400, zoom: 2 })
  const expected = createSpaceMouseCamera(h.state())
  for (const [method, key] of [['getViewMatrix', 'matrix'], ['getViewExtents', 'extents'],
    ['getModelExtents', 'modelExtents'], ['getPivotPosition', 'pivot'],
    ['getCoordinateSystem', 'coordinateSystem'], ['getFrontView', 'frontView']]) {
    assert.deepEqual(h.client[method](), expected[key])
  }
  assert.equal(h.client.getPerspective(), false)
  assert.equal(h.client.getSelectionEmpty(), true)
  assert.equal(h.client.getUnitsToMeters(), 0.001)
  assert.equal(h.client.getConstructionPlane(), null)
  assert.equal(h.client.getViewRotatable(), true)
  assert.deepEqual(h.client.getFloorPlane(), [0, 0, 1, 0])
  assert.equal(h.client.getLookAt(), null)
  for (const name of ['setLookFrom', 'setLookDirection', 'setLookAperture', 'setSelectionOnly']) h.client[name]({})
})

test('writes, including unchanged values, never confirm input; idle deadline is advisory only', t => {
  const h = setup(t)
  h.ready()
  h.client.setViewMatrix(h.client.getViewMatrix())
  h.client.setViewExtents(h.client.getViewExtents())
  const matrix = h.client.getViewMatrix()
  matrix[12] += 40
  h.client.setViewMatrix(matrix)
  assert.equal(h.changes.length, 3)
  assert.equal(h.statuses.at(-1).message, readyMessage)
  t.mock.timers.tick(15000)
  assert.deepEqual(h.statuses.at(-1), { connected: true, connecting: false, message: advisory })
  assert.equal(h.transport.closes, 0)
  h.client.onStartMotion()
  assert.deepEqual(h.statuses.at(-1), { connected: true, connecting: false, message: 'SpaceMouse input confirmed.' })
  const count = h.statuses.length
  h.client.onStartMotion()
  h.client.onStopMotion()
  h.client.on3dmouseCreated()
  t.mock.timers.tick(30000)
  assert.equal(h.statuses.length, count)
  assert.equal(h.transport.closes, 0)
})

test('motion before the deadline confirms once and cancels the advisory', t => {
  const h = setup(t)
  h.ready()
  t.mock.timers.tick(14999)
  h.client.onStartMotion()
  h.client.onStopMotion()
  t.mock.timers.tick(30000)
  assert.equal(h.statuses.length, 3)
  assert.equal(h.statuses.at(-1).message, 'SpaceMouse input confirmed.')
})

for (const block of ['disabled', 'hidden', 'document', 'window', 'target', 'viewport blur']) {
  test(`${block} gates focus, writes, transactions, motion and advisory; restored focus can confirm`, t => {
    const h = setup(t)
    h.ready()
    t.mock.timers.tick(14000)
    const matrix = h.client.getViewMatrix()
    matrix[12] += 40
    h.client.setTransaction(1)
    h.client.setViewMatrix(matrix)
    if (block === 'disabled') h.enable(false)
    if (block === 'hidden') h.doc.hidden = true
    if (block === 'document') h.focus(false)
    if (block === 'window') h.win.dispatchEvent(new Event('blur'))
    if (block === 'target') h.doc.activeElement = {}
    if (block === 'viewport blur') {
      // During blur, activeElement can still be the old viewport.
      h.viewport.dispatchEvent(new Event('blur'))
      assert.deepEqual(h.transport.updates.at(-1), { focus: false })
      h.doc.activeElement = h.doc.body
    }
    h.cleanup.syncFocus()
    assert.deepEqual(h.transport.updates.at(-1), { focus: false })
    h.client.setViewMatrix(matrix)
    h.client.setViewExtents(h.client.getViewExtents())
    h.client.setTransaction(1)
    h.client.onStartMotion()
    t.mock.timers.tick(30000)
    assert.equal(h.changes.length, 0)
    assert.equal(h.frames.size, 0)
    assert.equal(h.statuses.at(-1).message, readyMessage)
    assert.equal(h.transport.closes, 0)
    assert.equal(h.client.getViewRotatable(), true)
    assert.equal(h.client.getConstructionPlane(), null)
    h.enable(true); h.doc.hidden = false; h.focus(true); h.doc.activeElement = h.viewport
    h.win.dispatchEvent(new Event('focus'))
    assert.deepEqual(h.transport.updates.at(-1), { focus: true })
    h.client.setTransaction(0)
    assert.equal(h.changes.length, 0)
    t.mock.timers.tick(14999)
    assert.equal(h.statuses.at(-1).message, readyMessage)
    h.client.onStartMotion()
    assert.equal(h.statuses.at(-1).message, 'SpaceMouse input confirmed.')
  })
}

test('initially ineligible canvas has no advisory until a full eligible interval elapses', t => {
  const h = setup(t)
  h.doc.activeElement = h.doc.body
  h.ready()
  t.mock.timers.tick(60000)
  assert.equal(h.statuses.at(-1).message, readyMessage)
  assert.ok(!h.transport.updates.some(value => value.focus === true))
  h.doc.activeElement = h.viewport
  h.doc.dispatchEvent(new Event('focusin'))
  t.mock.timers.tick(14999)
  assert.equal(h.statuses.at(-1).message, readyMessage)
  t.mock.timers.tick(1)
  assert.equal(h.statuses.at(-1).message, advisory)
  assert.equal(h.transport.closes, 0)
})

test('a dynamic input block at the deadline suppresses the advisory even without a focus event', t => {
  const h = setup(t)
  h.ready()
  h.enable(false)
  t.mock.timers.tick(15000)
  assert.equal(h.statuses.at(-1).message, readyMessage)
  h.enable(true)
  h.cleanup.syncFocus()
  t.mock.timers.tick(15000)
  assert.equal(h.statuses.at(-1).message, advisory)
})

test('brief focus loss resets the advisory deadline; repeated eligible sync does not postpone it', t => {
  const h = setup(t)
  h.ready()
  t.mock.timers.tick(14000)
  h.enable(false)
  h.cleanup.syncFocus()
  t.mock.timers.tick(100)
  h.enable(true)
  h.cleanup.syncFocus()
  t.mock.timers.tick(14999)
  assert.equal(h.statuses.at(-1).message, readyMessage)
  h.cleanup.syncFocus()
  t.mock.timers.tick(1)
  assert.equal(h.statuses.at(-1).message, advisory)
  assert.equal(h.transport.closes, 0)
})

for (const order of [['matrix', 'extents'], ['extents', 'matrix']]) {
  test(`asymmetric transaction ${order.join(' then ')} resolves once, with repeat-safe raw inputs and getters`, t => {
    const h = setup(t)
    h.ready()
    const base = structuredClone(h.state())
    const matrix = h.client.getViewMatrix()
    matrix[12] += 40
    const extents = h.client.getViewExtents().map((v, i) => i === 2 || i === 5 ? v : v / 2 + (i % 3 === 0 ? 12 : -7))
    const inputs = { matrix, extents }, pending = {}
    const write = key => h.client[key === 'matrix' ? 'setViewMatrix' : 'setViewExtents'](inputs[key])
    h.client.setTransaction(1)
    for (const key of order) {
      write(key)
      write(key)
      pending[key] = inputs[key]
      const expected = createSpaceMouseCamera({ ...base, ...applySpaceMouseTransaction(base, pending) })
      assert.deepEqual(h.client.getViewMatrix(), expected.matrix)
      assert.deepEqual(h.client.getViewExtents(), expected.extents)
    }
    h.client.setTransaction(2)
    h.client.setViewMatrix([NaN])
    h.client.setViewExtents([0, 0, 0, 0, 0, 0])
    assert.equal(h.changes.length, 0)
    const expected = applySpaceMouseTransaction(base, inputs)
    matrix[12] = NaN
    extents[0] = NaN
    h.client.setTransaction(0)
    assert.deepEqual(h.changes, [expected])
    h.client.setTransaction(0)
    assert.equal(h.changes.length, 1)
    assert.equal(h.statuses.at(-1).message, readyMessage)
  })
}

test('transactions retain latest candidates rather than accumulating prior absolute writes', t => {
  const h = setup(t)
  h.ready()
  const base = structuredClone(h.state())
  const matrix = h.client.getViewMatrix(), extents = h.client.getViewExtents()
  h.client.setTransaction(1)
  h.client.setViewMatrix(matrix)
  h.client.setViewExtents(extents)
  matrix[12] += 80
  for (const i of [0, 1, 3, 4]) extents[i] /= 2
  h.client.setViewExtents(extents)
  h.client.setViewMatrix(matrix)
  h.client.setTransaction(0)
  assert.deepEqual(h.changes, [applySpaceMouseTransaction(base, { matrix, extents })])
})

for (const field of ['width', 'height', 'zoom', 'fitScale', 'pan.x', 'pan.y',
  'orientation.x', 'orientation.y', 'orientation.z', 'orientation.w']) {
  test(`foreign ${field} change discards a stale transaction, including in-place parent changes`, t => {
    const h = setup(t)
    h.ready()
    h.client.setTransaction(1)
    const matrix = h.client.getViewMatrix()
    matrix[12] += 40
    h.client.setViewMatrix(matrix)
    const [object, key] = field.split('.')
    if (key) h.state()[object][key] += 0.1
    else h.setState({ [field]: h.state()[field] * 2 })
    const expected = createSpaceMouseCamera(h.state())
    assert.deepEqual(h.client.getViewMatrix(), expected.matrix)
    assert.deepEqual(h.client.getViewExtents(), expected.extents)
    h.client.setViewMatrix(matrix)
    h.client.setTransaction(0)
    assert.equal(h.changes.length, 0)
    h.client.setTransaction(1)
    h.client.setViewMatrix(matrix)
    h.client.setTransaction(0)
    assert.equal(h.changes.length, 1)
  })
}

test('foreign state change is checked at commit even without intermediate getters', t => {
  const h = setup(t)
  h.ready()
  h.client.setTransaction(1)
  h.client.setViewMatrix(h.client.getViewMatrix())
  h.setState({ width: 900 })
  h.client.setTransaction(0)
  assert.equal(h.changes.length, 0)
})

test('invalid, empty and pre-creation transactions are no-ops; immediate writes use current state', t => {
  const h = setup(t)
  h.client.setTransaction(1)
  h.client.setViewMatrix(h.client.getViewMatrix())
  h.client.onStartMotion()
  assert.equal(h.changes.length, 0)
  assert.equal(h.frames.size, 0)
  h.ready()
  for (const value of [0, -1, NaN, '1', 0.5]) h.client.setTransaction(value)
  h.client.setTransaction(1)
  h.client.setViewMatrix(null)
  h.client.setViewExtents(null)
  h.client.setTransaction(0)
  assert.equal(h.changes.length, 0)
  const matrix = h.client.getViewMatrix()
  h.setState({ zoom: 3 })
  const expected = applySpaceMouseTransaction(h.state(), { matrix })
  h.client.setViewMatrix(matrix)
  assert.deepEqual(h.changes, [expected])
})

test('motion publishes timing; stop, disable and reentrant disconnect cancel RAF', t => {
  const h = setup(t)
  h.ready()
  assert.equal(h.client.getFrameTimingSource(), 1)
  assert.equal(h.client.getFrameTime(), 0)
  h.client.onStartMotion()
  h.client.onStartMotion()
  assert.equal(h.frames.size, 1)
  h.tick(123.5)
  assert.equal(h.client.getFrameTime(), 123.5)
  assert.deepEqual(h.transport.updates.at(-1), { frame: { time: 123.5 } })
  h.client.onStopMotion()
  assert.equal(h.frames.size, 0)
  h.client.onStartMotion()
  h.enable(false)
  h.tick(140)
  assert.equal(h.frames.size, 0)
  h.enable(true)
  h.client.onStartMotion()
  h.transport.update3dcontroller = () => h.client.onDisconnect('SpaceMouse controller update failed.')
  h.tick(150)
  assert.equal(h.frames.size, 0)
  assert.equal(h.transport.closes, 1)
})

for (const connected of [false, true]) {
  test(`startup timeout closes transport during ${connected ? 'creation' : 'discovery'}`, t => {
    const h = setup(t)
    if (connected) h.client.onConnect()
    t.mock.timers.tick(10000)
    assert.match(h.statuses.at(-1).message, /^3Dconnexion driver connection timed out\./)
    assert.equal(h.statuses.at(-1).connecting, false)
    assert.equal(h.transport.closes, 1)
    const count = h.statuses.length, creates = h.transport.creates
    h.client.onConnect()
    h.client.on3dmouseCreated()
    h.client.onStartMotion()
    h.cleanup()
    assert.equal(h.statuses.length, count)
    assert.equal(h.transport.creates, creates)
    assert.equal(h.frames.size, 0)
    assert.equal(h.transport.closes, 1)
  })
}

for (const stage of ['discovery', 'creation', 'ready', 'motion']) {
  test(`cleanup during ${stage} closes once, removes listeners and ignores late callbacks`, t => {
    const h = setup(t)
    if (stage === 'creation') h.client.onConnect()
    if (stage === 'ready' || stage === 'motion') h.ready()
    if (stage === 'motion') h.client.onStartMotion()
    h.cleanup()
    const count = h.statuses.length, updates = h.transport.updates.length
    h.client.onConnect()
    h.client.on3dmouseCreated()
    h.client.onStartMotion()
    h.client.onDisconnect('Late disconnect')
    h.client.setViewMatrix([])
    h.client.setTransaction(0)
    h.cleanup.syncFocus()
    h.doc.dispatchEvent(new Event('focusin'))
    h.win.dispatchEvent(new Event('focus'))
    h.viewport.dispatchEvent(new Event('blur'))
    t.mock.timers.tick(60000)
    h.cleanup()
    assert.equal(h.statuses.length, count)
    assert.equal(h.transport.updates.length, updates)
    assert.equal(h.transport.closes, 1)
    assert.equal(h.frames.size, 0)
    assert.equal(h.changes.length, 0)
    assert.equal(h.client.getViewMatrix(), null)
  })
}

test('disconnect preserves the transport sanitized error exactly, even with recursive close', t => {
  const h = setup(t)
  h.ready()
  const message = 'SpaceMouse discovery failed. Check 3DxWare, local-network access, and its TLS certificate.'
  h.client.onDisconnect(message)
  assert.deepEqual(h.statuses.at(-1), { connected: false, connecting: false, message })
  assert.equal(h.transport.closes, 1)
})

test('default transport uses the local implementation and its real close method', t => {
  let instance
  t.mock.method(SpaceMouseTransport.prototype, 'connect', function () { instance = this; return 1 })
  const close = t.mock.method(SpaceMouseTransport.prototype, 'close')
  const h = setup(t, { Transport: undefined })
  assert.ok(instance instanceof SpaceMouseTransport)
  h.cleanup()
  h.cleanup()
  assert.equal(close.mock.callCount(), 1)
  assert.equal(instance.state, 'closed')
})

for (const method of ['constructor', 'connect', 'create3dmouse']) {
  test(`${method} exceptions produce fixed sanitized errors`, t => {
    class Transport {
      constructor(client) { this.client = client; if (method === 'constructor') throw new Error('private payload') }
      connect() { if (method === 'connect') throw new Error('private payload'); this.client.onConnect(); return 1 }
      create3dmouse() { throw new Error('private payload') }
      close() {}
    }
    const h = setup(t, { Transport })
    assert.deepEqual(h.statuses.at(-1), { connected: false, connecting: false,
      message: method === 'create3dmouse' ? 'SpaceMouse controller creation failed.'
        : '3Dconnexion driver connection failed. Check that 3DxWare is running and local-network access is allowed.' })
  })
}

for (const invalid of [{ zoom: NaN }, { width: 0 }, { fitScale: Infinity },
  { orientation: { x: NaN, y: 0, z: 0, w: 1 } }, { zoom: Number.MAX_VALUE, fitScale: Number.MAX_VALUE }]) {
  test(`invalid camera state ${Object.keys(invalid).join('/')} fails once and getters return null`, t => {
    const h = setup(t)
    h.ready()
    h.setState(invalid)
    for (const method of ['getViewMatrix', 'getViewExtents', 'getModelExtents',
      'getPivotPosition', 'getCoordinateSystem', 'getFrontView']) {
      assert.equal(h.client[method](), null)
    }
    assert.deepEqual(h.statuses.at(-1), { connected: false, connecting: false, message: 'SpaceMouse camera state is invalid.' })
    assert.equal(h.statuses.length, 3)
    assert.equal(h.transport.closes, 1)
    assert.equal(h.changes.length, 0)
  })
}

test('invalid initial state prevents controller creation; throwing state getters are sanitized', t => {
  const h = setup(t, { getCameraState: () => { throw new RangeError('private payload') } })
  h.client.onConnect()
  assert.equal(h.transport.creates, undefined)
  assert.equal(h.statuses.at(-1).message, 'SpaceMouse camera state is invalid.')
  assert.equal(h.transport.closes, 1)
})

test('invalid state shutdown tolerates reentrant metadata reads without recursion', t => {
  const h = setup(t)
  h.ready()
  const close = h.transport.close.bind(h.transport)
  h.transport.close = () => {
    assert.equal(h.client.getViewMatrix(), null)
    assert.equal(h.client.getViewExtents(), null)
    close()
  }
  h.setState({ height: NaN })
  assert.equal(h.client.getViewMatrix(), null)
  assert.equal(h.transport.closes, 1)
  assert.equal(h.statuses.length, 3)
})

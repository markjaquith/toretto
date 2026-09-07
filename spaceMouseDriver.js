import { createSpaceMouseCamera, applySpaceMouseTransaction } from './spaceMouse.js'
import { SpaceMouseTransport } from './spaceMouseTransport.js'

export function connectSpaceMouseDriver({
  Transport = SpaceMouseTransport, viewport, getCameraState, isEnabled, onCameraChange, onStatus,
  timeoutMs = 10000, inputTimeoutMs = 15000,
}) {
  const doc = viewport.ownerDocument || document
  const win = doc.defaultView || window
  let transport, startupTimer, inputTimer = null, frame = null, frameTime = 0
  let stopped = false, created = false, moving = false, verified = false, advised = false
  let transaction = null, pending = {}, stale = false
  let windowFocused = true
  const eligible = () => !stopped && windowFocused && isEnabled() &&
    doc.hasFocus() && !doc.hidden && doc.activeElement === viewport

  function state() {
    if (stopped) return null
    try {
      const current = getCameraState()
      createSpaceMouseCamera(current)
      if (transaction && (
        ['zoom', 'fitScale', 'width', 'height', 'modelWidth', 'modelHeight', 'depth']
          .some(key => current[key] !== transaction[key]) ||
        ['x', 'y'].some(key => current.pan[key] !== transaction.pan[key]) ||
        ['x', 'y', 'z', 'w'].some(key => current.orientation[key] !== transaction.orientation[key])
      )) stale = true
      return transaction && !stale
        ? { ...transaction, ...applySpaceMouseTransaction(transaction, pending) }
        : current
    } catch {
      fail('SpaceMouse camera state is invalid.')
      return null
    }
  }

  function camera() {
    const current = state()
    if (!current) return null
    try { return createSpaceMouseCamera(current) }
    catch {
      fail('SpaceMouse camera state is invalid.')
      return null
    }
  }

  function stopMotion() {
    moving = false
    if (frame !== null) win.cancelAnimationFrame(frame)
    frame = null
  }

  function clearPending() {
    transaction = null
    pending = {}
    stale = false
    stopMotion()
  }

  function syncFocus(focused = eligible()) {
    if (stopped) return
    if (!focused) {
      clearPending()
      clearTimeout(inputTimer)
      inputTimer = null
    }
    if (!created) return
    if (focused) transport.focus()
    else transport.blur()
    if (!stopped && focused && !verified && !advised && inputTimer === null) {
      inputTimer = setTimeout(() => {
        inputTimer = null
        if (!eligible()) { syncFocus(); return }
        advised = true
        onStatus({ connected: true, connecting: false,
          message: 'No SpaceMouse input received yet. Check the device and driver, focus the canvas, and move the cap. The connection remains open.' })
      }, inputTimeoutMs)
    }
  }

  function cleanup() {
    if (stopped) return
    stopped = true
    created = false
    clearTimeout(startupTimer)
    clearTimeout(inputTimer)
    inputTimer = null
    clearPending()
    for (const [target, event, listener] of listeners) target.removeEventListener(event, listener)
    try { transport?.close() } catch { /* Local cleanup must finish even if close fails. */ }
  }
  cleanup.syncFocus = () => syncFocus()

  function fail(message) {
    if (stopped) return
    cleanup()
    onStatus({ connected: false, connecting: false, message })
  }

  function write(key, value) {
    if (!eligible() || !created) { syncFocus(); return }
    const current = state()
    if (!current || stale) return
    const inputs = { ...pending, [key]: value }
    const update = applySpaceMouseTransaction(transaction || current, inputs)
    if (!update) return
    if (transaction) pending = { ...inputs, [key]: Array.from(value) }
    else onCameraChange(update)
  }

  function tick(time) {
    frame = null
    if (!eligible()) { syncFocus(); return }
    if (!moving) return
    frameTime = time
    transport.update3dcontroller({ frame: { time } })
    if (moving && eligible()) frame = win.requestAnimationFrame(tick)
  }

  const client = {
    getViewMatrix: () => camera()?.matrix ?? null,
    getViewExtents: () => camera()?.extents ?? null,
    getModelExtents: () => camera()?.modelExtents ?? null,
    getPivotPosition: () => camera()?.pivot ?? null,
    getCoordinateSystem: () => camera()?.coordinateSystem ?? null,
    getFrontView: () => camera()?.frontView ?? null,
    getPerspective: () => false,
    // Capability is permanent; focus and write guards handle temporary input blocks.
    getViewRotatable: () => true,
    getSelectionEmpty: () => true,
    getUnitsToMeters: () => 0.001,
    // A front-aligned construction plane would lock orthographic rotation after Reset.
    getConstructionPlane: () => null,
    getFloorPlane: () => [0, 0, 1, 0],
    getLookAt: () => null,
    setLookFrom() {},
    setLookDirection() {},
    setLookAperture() {},
    setSelectionOnly() {},
    getFrameTimingSource: () => 1,
    getFrameTime: () => frameTime,
    setViewMatrix: value => write('matrix', value),
    setViewExtents: value => write('extents', value),
    setTransaction(value) {
      if (!eligible() || !created) { syncFocus(); return }
      if (!Number.isInteger(value) || value < 0) return
      if (value === 0 && !transaction) return
      const current = state()
      if (!current) return
      if (value !== 0) {
        if (!transaction) {
          transaction = { ...current, pan: { ...current.pan }, orientation: { ...current.orientation } }
          pending = {}
          stale = false
        }
      } else {
        const update = !stale && applySpaceMouseTransaction(transaction, pending)
        transaction = null
        pending = {}
        stale = false
        if (update) onCameraChange(update)
      }
    },
    onStartMotion() {
      if (!eligible() || !created) { syncFocus(); return }
      if (!verified) {
        verified = true
        clearTimeout(inputTimer)
        inputTimer = null
        onStatus({ connected: true, connecting: false, message: 'SpaceMouse input confirmed.' })
      }
      if (stopped) return
      moving = true
      if (frame === null) frame = win.requestAnimationFrame(tick)
    },
    onStopMotion: stopMotion,
    onConnect() {
      if (stopped || !camera()) return
      try { transport.create3dmouse(viewport, 'Toretto') }
      catch { fail('SpaceMouse controller creation failed.') }
    },
    on3dmouseCreated() {
      if (stopped || created || !camera()) return
      created = true
      clearTimeout(startupTimer)
      onStatus({ connected: true, connecting: false,
        message: '3Dconnexion driver connected. Focus the canvas and move the SpaceMouse to confirm input.' })
      if (stopped) return
      transport.update3dcontroller({ frame: { timingSource: 1 } })
      syncFocus()
    },
    onDisconnect(message) { fail(message || '3Dconnexion driver disconnected. Reconnect to try again.') },
  }
  const listeners = [
    [win, 'blur', () => { windowFocused = false; syncFocus() }],
    [win, 'focus', () => { windowFocused = true; syncFocus() }],
    [doc, 'focusin', () => syncFocus()],
    [doc, 'visibilitychange', () => syncFocus()],
    [viewport, 'blur', () => syncFocus(false)],
  ]
  onStatus({ connected: false, connecting: true, message: 'Connecting to 3Dconnexion driver...' })
  try {
    transport = new Transport(client)
    for (const [target, event, listener] of listeners) target.addEventListener(event, listener)
    startupTimer = setTimeout(() => fail('3Dconnexion driver connection timed out. Check that 3DxWare is running, allow browser local-network access if prompted, and retry. Do not disable certificate checks.'), timeoutMs)
    if (transport.connect() === 0) fail('3Dconnexion driver connection failed. Check that 3DxWare is running and local-network access is allowed.')
  } catch { fail('3Dconnexion driver connection failed. Check that 3DxWare is running and local-network access is allowed.') }
  return cleanup
}

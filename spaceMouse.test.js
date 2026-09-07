import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpaceMouseCamera, applySpaceMouseView, applySpaceMouseExtents, applySpaceMouseTransaction } from './spaceMouse.js'

const state = {
  orientation: { x: 0, y: 0, z: 0, w: 1 },
  pan: { x: 123, y: -78 }, zoom: 1.7, fitScale: 0.6, width: 1200, height: 800,
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function close(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`)
}

function samePan(actual, expected) {
  close(actual.x, expected.x)
  close(actual.y, expected.y)
}

function sameRotation(actual, expected) {
  const norm = Math.hypot(expected.x, expected.y, expected.z, expected.w)
  const dot = ['x', 'y', 'z', 'w'].reduce((sum, key) => sum + actual[key] * expected[key] / norm, 0)
  close(Math.abs(dot), 1)
  close(Math.hypot(actual.x, actual.y, actual.z, actual.w), 1)
}

test('creates column-major camera WORLD matrix and orthographic SDK metadata', () => {
  const camera = createSpaceMouseCamera({ ...state, depth: 240 })
  const s = state.zoom * state.fitScale
  camera.matrix.slice(0, 12).forEach((value, i) => close(value, identity[i]))
  close(camera.matrix[12], -state.pan.x / s)
  close(camera.matrix[13], state.pan.y / s)
  assert.equal(camera.matrix[14], 10000)
  assert.equal(camera.matrix[15], 1)
  assert.deepEqual(camera.extents, [-600 / s, -400 / s, -1000000, 600 / s, 400 / s, -0.01])
  assert.deepEqual(camera.modelExtents, [-720, -450, 0, 720, 450, 240])
  assert.deepEqual(camera.pivot, [0, 0, 120])
  assert.deepEqual(camera.coordinateSystem, identity)
  assert.deepEqual(camera.frontView, identity)
  const custom = createSpaceMouseCamera({ ...state, modelWidth: 100, modelHeight: 80, depth: -20 })
  assert.deepEqual(custom.modelExtents, [-50, -40, 0, 50, 40, 0])
  assert.deepEqual(custom.pivot, [0, 0, 0])
  assert.equal(createSpaceMouseCamera(state).modelExtents[5], 0)
})

test('arbitrary quaternions, pan and zoom round-trip including all half-turn branches', () => {
  const rotations = [state.orientation, { x: 0.2, y: -0.4, z: 0.7, w: -0.5 }]
  for (const axis of ['x', 'y', 'z']) {
    for (const angle of [-Math.PI, -0.7, 0.7, Math.PI]) {
      rotations.push({ x: 0, y: 0, z: 0, w: Math.cos(angle / 2), [axis]: Math.sin(angle / 2) })
    }
  }
  for (const orientation of rotations) {
    for (const zoom of [0.12 ** 2.5, 1, 4 ** 2.5]) {
      for (const pan of [{ x: 0, y: 0 }, state.pan, { x: -700, y: 320 }]) {
        const input = { ...state, orientation, zoom, pan }
        const camera = createSpaceMouseCamera(input)
        const result = applySpaceMouseView(input, camera.matrix)
        sameRotation(result.orientation, orientation)
        samePan(result.pan, pan)
        const extentResult = applySpaceMouseExtents(input, camera.extents)
        close(extentResult.zoom, zoom)
        samePan(extentResult.pan, pan)
      }
    }
  }
})

test('six camera axes have the expected CSS signs; camera-local dolly does not zoom', () => {
  const input = { ...state, pan: { x: 0, y: 0 } }
  const s = input.zoom * input.fitScale
  for (const sign of [-1, 1]) {
    for (let axis = 0; axis < 3; axis++) {
      const matrix = [...identity]
      matrix[12 + axis] = sign * 10
      const result = applySpaceMouseView(input, matrix)
      samePan(result.pan, { x: axis === 0 ? -sign * 10 * s : 0, y: axis === 1 ? sign * 10 * s : 0 })
      sameRotation(result.orientation, state.orientation)
      assert.deepEqual(Object.keys(result).sort(), ['orientation', 'pan'])
      // Independently constructed positive camera rotations, column-major.
      const c = Math.cos(sign * 0.6), t = Math.sin(sign * 0.6)
      const rotations = [
        [1, 0, 0, 0, 0, c, t, 0, 0, -t, c, 0, 0, 0, 0, 1],
        [c, 0, -t, 0, 0, 1, 0, 0, t, 0, c, 0, 0, 0, 0, 1],
        [c, t, 0, 0, -t, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      ]
      const expected = { x: 0, y: 0, z: 0, w: Math.cos(0.3) }
      expected[['x', 'y', 'z'][axis]] = (axis === 1 ? -1 : 1) * Math.sin(sign * 0.3)
      sameRotation(applySpaceMouseView(input, rotations[axis]).orientation, expected)
      const created = createSpaceMouseCamera({ ...input, orientation: expected }).matrix
      created.slice(0, 12).forEach((value, i) => close(value, rotations[axis][i]))
    }
  }
  const rotated = { ...state, orientation: { x: 0.2, y: 0.3, z: -0.4, w: 0.5 } }
  const camera = createSpaceMouseCamera(rotated)
  for (let i = 0; i < 3; i++) camera.matrix[12 + i] += camera.matrix[8 + i] * 900
  samePan(applySpaceMouseView(rotated, camera.matrix).pan, state.pan)
})

test('rejects malformed, nonfinite, projective, scaled, reflected and sheared matrices', () => {
  for (const matrix of [null, undefined, {}, '0'.repeat(16), [], identity.slice(1), [...identity, 0]]) {
    assert.equal(applySpaceMouseView(state, matrix), null)
  }
  for (let i = 0; i < 16; i++) {
    for (const value of [NaN, Infinity, -Infinity, '1']) {
      const matrix = [...identity]
      matrix[i] = value
      assert.equal(applySpaceMouseView(state, matrix), null)
    }
  }
  for (const [index, value] of [[3, 0.01], [7, 0.01], [11, -1], [15, 0], [0, 2], [0, -1], [4, 0.01]]) {
    const matrix = [...identity]
    matrix[index] = value
    assert.equal(applySpaceMouseView(state, matrix), null)
  }
  const almostRigid = new Float64Array(identity)
  almostRigid[0] += 1e-6
  const result = applySpaceMouseView(state, almostRigid)
  sameRotation(result.orientation, state.orientation)
})

test('zoom uses extents, keeps camera distance fixed and scales pan to preserve virtual position', () => {
  const camera = createSpaceMouseCamera(state)
  const extents = camera.extents.map((value, i) => i === 2 || i === 5 ? value : value / 2)
  const result = applySpaceMouseExtents(state, extents)
  close(result.zoom, state.zoom * 2)
  samePan(result.pan, { x: state.pan.x * 2, y: state.pan.y * 2 })
  const next = createSpaceMouseCamera({ ...state, ...result })
  next.matrix.forEach((value, i) => close(value, camera.matrix[i]))
})

test('asymmetric extents offset pan with the new scale, including zoom clamping', () => {
  for (const requestedZoom of [1e-5, 0.8, 10000]) {
    const requestedScale = requestedZoom * state.fitScale
    const extents = [-state.width / (2 * requestedScale) + 12, -state.height / (2 * requestedScale) - 7,
      -1000000, state.width / (2 * requestedScale) + 12, state.height / (2 * requestedScale) - 7, -0.01]
    const result = applySpaceMouseExtents(state, new Float64Array(extents))
    const zoom = Math.max(0.12 ** 2.5, Math.min(4 ** 2.5, requestedZoom))
    close(result.zoom, zoom)
    samePan(result.pan, { x: state.pan.x * zoom / state.zoom - 12 * state.fitScale * zoom,
      y: state.pan.y * zoom / state.zoom - 7 * state.fitScale * zoom })
  }
})

test('rejects malformed extents, invalid spans, perspective shapes and invalid state', () => {
  const valid = createSpaceMouseCamera(state).extents
  for (const extents of [null, undefined, {}, [], valid.slice(1), [...valid, 0],
    [0, -1, -100, 0, 1, -1], [1, -1, -100, -1, 1, -1],
    [-1, 1, -100, 1, -1, -1], [-1, -1, -1, 1, 1, -100],
    [-1, -1, -100, 1, 1, 0], [-1, -1, -100, 1, 1, -1],
    [-Number.MAX_VALUE, -1, -100, Number.MAX_VALUE, 1, -1]]) {
    assert.equal(applySpaceMouseExtents(state, extents), null)
  }
  for (let i = 0; i < 6; i++) {
    for (const value of [NaN, Infinity, -Infinity, '1']) {
      const extents = [...valid]
      extents[i] = value
      assert.equal(applySpaceMouseExtents(state, extents), null)
    }
  }
  for (const key of ['width', 'height', 'fitScale', 'zoom']) {
    for (const value of [0, -1, NaN, Infinity]) {
      assert.equal(applySpaceMouseExtents({ ...state, [key]: value }, valid), null)
    }
  }
})

test('adapter does not mutate input state or SDK arrays', () => {
  const input = Object.freeze({ ...state, orientation: Object.freeze({ ...state.orientation }), pan: Object.freeze({ ...state.pan }) })
  const camera = createSpaceMouseCamera(input)
  Object.freeze(camera.matrix)
  Object.freeze(camera.extents)
  samePan(applySpaceMouseView(input, camera.matrix).pan, input.pan)
  samePan(applySpaceMouseExtents(input, camera.extents).pan, input.pan)
})

test('creation rejects invalid state with RangeError and never returns nonfinite metadata', () => {
  for (const input of [null, undefined, 1, {}, { ...state, pan: null }, { ...state, orientation: null }]) {
    assert.throws(() => createSpaceMouseCamera(input), RangeError)
  }
  const invalid = [undefined, null, '1', true, 1n, Symbol('invalid'), NaN, Infinity, -Infinity]
  for (const key of ['width', 'height', 'fitScale', 'zoom', 'modelWidth', 'modelHeight']) {
    for (const value of [0, -1, ...invalid]) {
      if (value === undefined && key.startsWith('model')) continue // Optional defaults.
      assert.throws(() => createSpaceMouseCamera({ ...state, [key]: value }), RangeError)
    }
  }
  for (const key of ['x', 'y', 'z', 'w']) {
    for (const value of invalid) {
      assert.throws(() => createSpaceMouseCamera({ ...state, orientation: { ...state.orientation, [key]: value } }), RangeError)
    }
  }
  for (const value of invalid) {
    assert.throws(() => createSpaceMouseCamera({ ...state, pan: { x: value, y: 0 } }), RangeError)
    assert.throws(() => createSpaceMouseCamera({ ...state, pan: { x: 0, y: value } }), RangeError)
    if (value !== undefined) assert.throws(() => createSpaceMouseCamera({ ...state, depth: value }), RangeError)
  }
  for (const changes of [
    { fitScale: 1e308, zoom: 2 }, { fitScale: 1e-300, zoom: 1e-300 },
    { fitScale: 1e-300, pan: { x: 1e308, y: 0 } },
    { fitScale: 1e-300, width: 1e308 }, { width: Number.MIN_VALUE },
    { modelHeight: Number.MIN_VALUE },
  ]) assert.throws(() => createSpaceMouseCamera({ ...state, ...changes }), RangeError)
  for (const changes of [{}, { fitScale: 1e308, zoom: 1 }, { depth: -20 }]) {
    const camera = createSpaceMouseCamera({ ...state, ...changes })
    assert.ok(Object.values(camera).flat().every(Number.isFinite))
    assert.ok(camera.extents[3] > 0 && camera.extents[4] > 0)
  }
})

test('finite zero quaternion falls back to identity; huge and subnormal quaternions normalize', () => {
  const zero = createSpaceMouseCamera({ ...state, orientation: { x: 0, y: 0, z: 0, w: 0 } })
  assert.deepEqual(zero, createSpaceMouseCamera(state))
  const expected = createSpaceMouseCamera({ ...state, orientation: { x: 1, y: -1, z: 1, w: -1 } })
  for (const magnitude of [1e308, Number.MIN_VALUE]) {
    const camera = createSpaceMouseCamera({ ...state, orientation: {
      x: magnitude, y: -magnitude, z: magnitude, w: -magnitude,
    } })
    camera.matrix.forEach((value, i) => close(value, expected.matrix[i]))
    assert.ok(Object.values(camera).flat().every(Number.isFinite))
  }
})

test('apply functions reject invalid individual scales and unrepresentable products without coercion', () => {
  const camera = createSpaceMouseCamera(state)
  for (const key of ['fitScale', 'zoom']) {
    for (const value of [0, -1, '1', true, null, undefined, NaN, Infinity, -Infinity, 1n, Symbol('invalid')]) {
      const input = { ...state, [key]: value }
      assert.equal(applySpaceMouseView(input, camera.matrix), null)
      assert.equal(applySpaceMouseExtents(input, camera.extents), null)
    }
  }
  for (const input of [null, undefined, { ...state, fitScale: -1, zoom: -1 },
    { ...state, fitScale: 1e308, zoom: 2 }, { ...state, fitScale: 1e-300, zoom: 1e-300 }]) {
    assert.equal(applySpaceMouseView(input, camera.matrix), null)
    assert.equal(applySpaceMouseExtents(input, camera.extents), null)
  }
  for (const key of ['width', 'height']) {
    assert.equal(applySpaceMouseExtents({ ...state, [key]: '1200' }, camera.extents), null)
  }
  assert.equal(applySpaceMouseExtents({ ...state, pan: null }, camera.extents), null)
})

test('absolute transactions resolve latest asymmetric inputs once regardless of arrival order', () => {
  const input = Object.freeze({ ...state, pan: Object.freeze({ x: 0, y: 0 }), fitScale: 1, zoom: 1 })
  const matrix = Object.freeze(createSpaceMouseCamera(input).matrix)
  const extents = Object.freeze([-290, -200, -1000000, 310, 200, -0.01])
  const expected = applySpaceMouseTransaction(input, { matrix, extents })
  samePan(expected.pan, { x: -20, y: 0 })
  close(expected.zoom, 2)
  for (const order of [['matrix', 'extents'], ['extents', 'matrix']]) {
    const latest = {}
    for (const key of order) latest[key] = key === 'matrix' ? matrix : extents
    for (let repeat = 0; repeat < 3; repeat++) {
      latest.extents = extents
      assert.deepEqual(applySpaceMouseTransaction(input, latest), expected)
    }
    latest.extents = [-280, -200, -1000000, 320, 200, -0.01]
    samePan(applySpaceMouseTransaction(input, latest).pan, { x: -40, y: 0 })
  }
  assert.deepEqual(applySpaceMouseTransaction(input, { matrix }), applySpaceMouseView(input, matrix))
  assert.deepEqual(applySpaceMouseTransaction(input, { extents }), applySpaceMouseExtents(input, extents))
  for (const inputs of [null, undefined, {}, [], 'invalid', { matrix: null }, { extents: undefined },
    { matrix: [NaN], extents }, { matrix, extents: [0, 0, 0, 0, 0, 0] }]) {
    assert.equal(applySpaceMouseTransaction(input, inputs), null)
  }
  assert.equal(applySpaceMouseTransaction({ ...input, zoom: '1' }, { matrix, extents }), null)
})

test('combined update matches independent orthographic point projection, not just adapter round trips', () => {
  const angle = 0.6, c = Math.cos(angle), s = Math.sin(angle)
  const matrix = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 40, -25, 9000, 1]
  const extents = [-290, -210, -1000000, 310, 190, -0.01]
  const result = applySpaceMouseTransaction(state, { extents, matrix })
  sameRotation(result.orientation, { x: 0, y: -Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) })
  for (const [x, y] of [[0, 0], [-120, 75], [300, -180]]) {
    // SDK world point (x, y, 0): inverse camera transform, then NDC to pixels.
    const cameraX = c * (x - 40) + s * 9000
    const cameraY = y + 25
    const expectedX = ((cameraX - extents[0]) / (extents[3] - extents[0]) - 0.5) * state.width
    const expectedY = (0.5 - (cameraY - extents[1]) / (extents[4] - extents[1])) * state.height
    // CSS base point (x, -y, 0), rotated about Y by -angle, with lens disabled.
    close(result.pan.x + state.fitScale * result.zoom * c * x, expectedX)
    close(result.pan.y - state.fitScale * result.zoom * y, expectedY)
  }
})

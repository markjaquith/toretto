const ZOOM_MIN = 0.12 ** 2.5
const ZOOM_MAX = 4 ** 2.5
const TOLERANCE = 1e-4

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

function finiteArray(value, length) {
  return (Array.isArray(value) || ArrayBuffer.isView(value)) &&
    value.length === length && Array.from(value).every(Number.isFinite)
}

function positiveFinite(value) {
  return Number.isFinite(value) && value > 0
}

// An orthographic NAVIGATION proxy, not the rendered perspective lens. It matches
// the untransformed, front-aligned base plane at camera Z zero, not tilted or
// exploded perspective geometry. Dolly is ignored; extents control zoom.
// The SDK consumes Three.js column-major camera WORLD matrices in right/up/out
// coordinates. Reflecting CSS's y-down basis gives scene q' = (-qx, qy, -qz, qw).
// Invalid state or unrepresentable metadata throws RangeError. A finite zero
// quaternion means identity; finite negative depth is clamped to the base plane.
export function createSpaceMouseCamera(cameraState) {
  if (!cameraState || typeof cameraState !== 'object') throw new RangeError('Invalid camera state')
  const { orientation, pan, zoom, fitScale, width, height,
    modelWidth = 1440, modelHeight = 900, depth = 0 } = cameraState
  const components = [orientation?.x, orientation?.y, orientation?.z, orientation?.w]
  if (![zoom, fitScale, width, height, modelWidth, modelHeight].every(positiveFinite) ||
      ![pan?.x, pan?.y, depth, ...components].every(Number.isFinite)) {
    throw new RangeError('Invalid camera state')
  }
  const s = fitScale * zoom
  if (!positiveFinite(s)) throw new RangeError('Unrepresentable camera scale')
  // Scale first so both huge and subnormal finite quaternions normalize safely.
  const largest = Math.max(...components.map(Math.abs))
  const scaled = largest === 0 ? [0, 0, 0, 1] : components.map(value => value / largest)
  const length = Math.hypot(...scaled)
  const x = scaled[0] / length
  const y = -scaled[1] / length
  const z = scaled[2] / length
  const w = scaled[3] / length
  const matrix = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ]
  for (let i = 0; i < 3; i++) {
    matrix[12 + i] = matrix[i] * (-pan.x / s) + matrix[4 + i] * (pan.y / s) + matrix[8 + i] * 10000
  }
  const modelDepth = Math.max(0, depth)
  const camera = {
    matrix,
    extents: [-width / s / 2, -height / s / 2, -1000000, width / s / 2, height / s / 2, -0.01],
    modelExtents: [-modelWidth / 2, -modelHeight / 2, 0, modelWidth / 2, modelHeight / 2, modelDepth],
    pivot: [0, 0, modelDepth / 2],
    coordinateSystem: identity(),
    frontView: identity(),
  }
  if (!Object.values(camera).every(values => values.every(Number.isFinite)) ||
      !(camera.extents[3] > 0 && camera.extents[4] > 0) ||
      !(camera.modelExtents[3] > 0 && camera.modelExtents[4] > 0)) {
    throw new RangeError('Unrepresentable camera metadata')
  }
  return camera
}

export function applySpaceMouseView(cameraState, matrix) {
  if (!finiteArray(matrix, 16) ||
      ![cameraState?.fitScale, cameraState?.zoom].every(positiveFinite)) return null
  const m = matrix
  if (Math.abs(m[3]) > TOLERANCE || Math.abs(m[7]) > TOLERANCE ||
      Math.abs(m[11]) > TOLERANCE || Math.abs(m[15] - 1) > TOLERANCE) return null
  for (let a = 0; a < 3; a++) {
    for (let b = a; b < 3; b++) {
      const dot = m[4 * a] * m[4 * b] + m[4 * a + 1] * m[4 * b + 1] + m[4 * a + 2] * m[4 * b + 2]
      if (Math.abs(dot - (a === b ? 1 : 0)) > TOLERANCE) return null
    }
  }
  const determinant = m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
  if (Math.abs(determinant - 1) > TOLERANCE) return null

  // Choose the largest quaternion component to stay stable near half turns.
  let x, y, z, w
  const trace = m[0] + m[5] + m[10]
  if (trace > 0) {
    const t = 2 * Math.sqrt(trace + 1)
    w = t / 4
    x = (m[6] - m[9]) / t
    y = (m[8] - m[2]) / t
    z = (m[1] - m[4]) / t
  } else if (m[0] > m[5] && m[0] > m[10]) {
    const t = 2 * Math.sqrt(1 + m[0] - m[5] - m[10])
    x = t / 4
    y = (m[4] + m[1]) / t
    z = (m[8] + m[2]) / t
    w = (m[6] - m[9]) / t
  } else if (m[5] > m[10]) {
    const t = 2 * Math.sqrt(1 + m[5] - m[0] - m[10])
    x = (m[4] + m[1]) / t
    y = t / 4
    z = (m[9] + m[6]) / t
    w = (m[8] - m[2]) / t
  } else {
    const t = 2 * Math.sqrt(1 + m[10] - m[0] - m[5])
    x = (m[8] + m[2]) / t
    y = (m[9] + m[6]) / t
    z = t / 4
    w = (m[1] - m[4]) / t
  }
  const length = Math.hypot(x, y, z, w)
  const s = cameraState.fitScale * cameraState.zoom
  const pan = {
    x: -s * (m[0] * m[12] + m[1] * m[13] + m[2] * m[14]),
    y: s * (m[4] * m[12] + m[5] * m[13] + m[6] * m[14]),
  }
  if (!(s > 0) || !Number.isFinite(s) || !Number.isFinite(pan.x) || !Number.isFinite(pan.y)) return null
  return { pan, orientation: { x: x / length, y: -y / length, z: z / length, w: w / length } }
}

export function applySpaceMouseExtents(cameraState, extents) {
  if (!cameraState || !finiteArray(extents, 6)) return null
  const [left, bottom, back, right, top, front] = extents
  const { width, height, fitScale, zoom: oldZoom, pan } = cameraState
  const spanX = right - left
  const spanY = top - bottom
  if (![width, height, fitScale, oldZoom, spanX, spanY].every(positiveFinite) ||
      !positiveFinite(fitScale * oldZoom) ||
      !(back < front && front < 0) || !Number.isFinite(pan?.x) || !Number.isFinite(pan?.y)) return null
  // A single orthographic scale must explain both spans; perspective/FOV
  // shapes cannot be mapped to this proxy without changing the rendered lens.
  const aspectRatio = (spanX / spanY) / (width / height)
  if (!Number.isFinite(aspectRatio) || Math.abs(aspectRatio - 1) > TOLERANCE) return null
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, height / spanY / fitScale))
  const s = fitScale * zoom
  const ratio = zoom / oldZoom
  if (![s, ratio].every(positiveFinite)) return null
  const nextPan = {
    x: pan.x * ratio - (left / 2 + right / 2) * s,
    y: pan.y * ratio + (bottom / 2 + top / 2) * s,
  }
  if (!Number.isFinite(nextPan.x) || !Number.isFinite(nextPan.y)) return null
  return { pan: nextPan, zoom }
}

// Callers validate writes separately and retain the latest raw absolute inputs.
// Resolve against the same base state each time, never a previously resolved pan.
export function applySpaceMouseTransaction(cameraState, inputs) {
  if (!inputs || typeof inputs !== 'object') return null
  const hasMatrix = Object.hasOwn(inputs, 'matrix')
  const hasExtents = Object.hasOwn(inputs, 'extents')
  if (!hasMatrix && !hasExtents) return null
  let update = {}
  if (hasMatrix) {
    update = applySpaceMouseView(cameraState, inputs.matrix)
    if (!update) return null
  }
  if (hasExtents) {
    const extentsUpdate = applySpaceMouseExtents({ ...cameraState, ...update }, inputs.extents)
    if (!extentsUpdate) return null
    update = { ...update, ...extentsUpdate }
  }
  return update
}

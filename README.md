# Toretto

Drive through the DOM in three dimensions.

Toretto turns an HTML document into an explorable spatial scene. Orbit, pan, roll, zoom, and separate nested elements along the z-axis without changing the source document's layout.

This repository currently contains the standalone proof of concept. The reusable engine and browser extension will be extracted as the project evolves.

Use **Open…** to preview and load pasted HTML, a saved website package, a PDF, the built-in demo, or a public or local-development URL rendered through background Chromium. Submitted HTML is sanitized and never executes scripts. PDF pages currently import as faithful visual planes. Public pages cannot pull private-network subresources into a snapshot, and Toretto blocks capture of its own studio URL. The planned browser extension will capture live and signed-in pages directly.

For loaded pages, the wheel zooms the Canvas (up/in, down/out), Shift-wheel pans it, and ⌘/Ctrl-wheel scrolls the page. Canvas zoom follows the pointer so the position under the mouse remains anchored. Captured links remain clickable and open safely in a new tab; dragging elsewhere continues to manipulate the Canvas.

## SpaceMouse

The **SpaceMouse** button is always available in the main toolbar. No device or driver probing happens until you click it; no settings or special URL are required. Keep the 3Dconnexion **3DxWare driver running** and click the button, then focus the canvas and move the cap. **Cancel SpaceMouse** cancels pending connections; clicking **SpaceMouse** while connected disconnects.

Toretto uses a small, locally bundled client for the WAMP v1 navigation protocol used by the [3Dconnexion Three.js example](https://3dconnexion.com/technical_support/web_threejs.html). The installed `3DxNLServer` still owns device access, navigation interpretation, and sensitivity. There is no WebHID chooser, remote SDK script, or need to stop the driver used by Fusion. The client has been connection-tested against macOS service 1.4.6.21008 in Chromium; Arc uses the same browser APIs. Other driver versions still require compatibility testing.

Connection and input are distinct: **Driver connected** does not claim a physical SpaceMouse is attached. Only a driver motion notification changes the status to **SpaceMouse input confirmed**; unchanged camera writes do not count. After 15 seconds of eligible canvas focus without motion, an advisory says no input has been received and leaves the connection open. Losing focus resets that advisory window. Browser APIs cannot reliably distinguish an idle device from an absent one through this driver protocol.

Slide/lift the cap to pan, push/pull to zoom, and tilt/twist to rotate. Only the focused canvas accepts camera updates: dialogs, editing fields, mouse drags, playback, export, and unfocused tabs cannot be moved by the SpaceMouse. Connection errors distinguish discovery, protocol, and request failures. If prompted, allow browser local-network access; do not bypass TLS checks.

The camera adapter uses the sample's column-major **camera-to-world** matrices, converts CSS's Y-down coordinates to the driver's Y-up coordinates, and resolves camera transactions against one state snapshot. Matrix/extents ordering and repeated absolute writes do not change the result; intervening resize or camera edits discard stale transactions. Invalid or unrepresentable numeric state is rejected before transmission.

The **orthographic navigation proxy** represents Toretto's pan/zoom/quaternion state, not its full CSS perspective projection. The rendered lens is unchanged; zoom uses view extents, not camera dolly. Model bounds and the orbit pivot describe the centered base document plane, not a precise exploded/transformed mesh. Walk/fly navigation, surface hit-testing, and device-button commands are not implemented. These are explicit adapter limits, not Fusion feature parity.

The view always advertises rotation support and no active construction plane (`null`, per SDK section 3.11.6). A front-aligned construction plane would activate the driver's orthographic sketch-plane rotation lock after Reset, even though Toretto remains a 3D canvas at zero explosion. Input suppression is handled separately through focus and write guards, without changing driver preferences.

Privacy and transport: discovery uses `https://127.51.68.120:8181/3dconnexion/nlproxy`, with credentials omitted, no referrer, and redirects rejected. Only a valid port on that same fixed loopback host may receive the subsequent secure WebSocket. No third-party JavaScript is downloaded or executed. The driver receives numeric camera metadata and the app origin, not the page path/query, inspected HTML, form values, screenshots, or exports. Callback dispatch is allowlisted, messages are size-limited, and outstanding requests are bounded and timed out. Cancellation aborts discovery, closes pending sockets, and prevents late creation replies from reviving a connection. There are no automatic reconnection loops.

The local client implements only the protocol subset needed by Toretto; it is not a bundled copy of 3DconnexionJS and does not redistribute the vendor SDK. The installed 3Dconnexion driver remains separately licensed by its vendor.

### SpaceMouse Tests

**Neither suite requires a SpaceMouse, the 3Dconnexion driver, device permissions, or access to the vendor's services.** Device and driver responses are simulated; these are not hardware acceptance tests.

| Command | Coverage | Requirements |
| --- | --- | --- |
| `npm run test:spacemouse` | SpaceMouse camera math, transactions, focus, input status, cancellation, and protocol validation | Installed project dependencies; no browser or running app needed |
| `npm run test:spacemouse:browser` | SpaceMouse protocol-to-React navigation, camera-command focus, dialog guards, and connection cancellation | Google Chrome installed and `npm run dev` running |

`npm test` is currently an alias for `npm run test:spacemouse`, and its output names that suite explicitly. It is **not an application-wide test suite**. The browser suite replaces discovery and driver WebSocket traffic with fakes and blocks unexpected off-origin HTTP requests. Set `TORETTO_TEST_URL` to use a different local app server.

Imports, general camera behavior, timelines, and exports do not yet have dedicated automated coverage. Passing these SpaceMouse suites or `npm run build` does not establish coverage of those features. Physical cap feel and compatibility with other driver versions still require separate hardware testing.

## Runtime direction

The standalone studio and browser extension are complementary rather than competing implementations:

- The extension attaches the spatial engine to the live DOM already rendered by Chromium. It preserves authentication, JavaScript state, media, fonts, scrolling, responsive layout, and browser DevTools semantics.
- The studio loads frozen Chromium snapshots, saved HTML packages, pasted markup, and PDFs. It owns deterministic export, scene authoring, animation, timelines, and portable project files.
- A shared scene core should own DOM indexing, stacking-context analysis, depth assignment, camera state, keyframes, and export contracts. Adapters should only provide a live DOM or frozen document surface.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the proposed boundary.

## Development

```sh
npm install
npm run dev
```

Build the production bundle with `npm run build`.

Animation export renders the timeline deterministically, one PNG frame at a time. The local studio service then packages PNG sequences or uses `ffmpeg` from `PATH` to encode MP4/H.264, transparent WebM/VP9, and transparent ProRes 4444. The static production bundle keeps still export available but requires a future native studio service for encoded animation output.

## Contributing and security

Contributions are welcome under the [contribution guidelines](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md).

Toretto is available under the [MIT License](LICENSE).

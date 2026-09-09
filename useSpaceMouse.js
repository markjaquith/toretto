import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { connectSpaceMouseDriver } from "./spaceMouseDriver.js";

export function useSpaceMouse({ viewportRef, enabled, isInputBlocked, cameraState, onCameraChange }) {
  const [connection, setConnection] = useState({ connected: false, connecting: false, message: "" });
  const current = useRef({ enabled, isInputBlocked, cameraState, onCameraChange });
  const session = useRef(null);
  const generation = useRef(0);

  useLayoutEffect(() => {
    current.current = { enabled, isInputBlocked, cameraState, onCameraChange };
  });

  useLayoutEffect(() => { session.current?.syncFocus(); }, [enabled]);

  useEffect(() => () => {
    generation.current += 1;
    session.current?.();
    session.current = null;
  }, []);

  function toggle() {
    if (session.current) {
      generation.current += 1;
      session.current();
      session.current = null;
      setConnection({ connected: false, connecting: false, message: "SpaceMouse disconnected." });
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) return;
    const request = ++generation.current;
    if (current.current.enabled) viewport.focus({ preventScroll: true });
    let failed = false;
    const cleanup = connectSpaceMouseDriver({
      viewport,
      isEnabled: () => current.current.enabled && !current.current.isInputBlocked(),
      getCameraState: () => ({
        ...current.current.cameraState,
        width: Math.max(1, viewport.clientWidth),
        height: Math.max(1, viewport.clientHeight),
      }),
      onCameraChange: (update) => {
        current.current.cameraState = { ...current.current.cameraState, ...update };
        current.current.onCameraChange(update);
      },
      onStatus: (status) => {
        if (request !== generation.current) return;
        setConnection(status);
        if (!status.connected && !status.connecting) {
          failed = true;
          session.current = null;
        }
      },
    });
    if (!failed) session.current = cleanup;
  }

  function syncFocus() {
    session.current?.syncFocus();
  }

  return { ...connection, status: connection.message, toggle, syncFocus };
}

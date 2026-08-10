/**
 * Whether the dev-container feature should be shown.
 *
 * False only in the Flatpak build, where the sandbox cannot reach a host Docker
 * or Podman daemon. Resolved once from the backend in
 * `registerBuiltinContributions()`, which `main.tsx` awaits before the first
 * render — so components can read this synchronously and never see a flash of
 * UI that is about to disappear.
 */
let supported = true;

export function setContainerSupport(value: boolean) {
  supported = value;
}

export function containerSupported() {
  return supported;
}

/**
 * Desktop builds use Electron's app:// protocol and do not install a service
 * worker. The web build continues to resolve this import through VitePWA.
 */
export function registerSW() {
  return () => undefined;
}

/**
 * Whether this browser is even capable of the offline layer, and what to say if it is not.
 *
 * DRV-12, and the reason this file exists at all is the deployment: this app is served to
 * phones on a private network over a VPN, at an address like `http://10.8.0.30`. The browser
 * cannot see the tunnel. It sees plain HTTP on a non-loopback host, which the Secure Contexts
 * spec does not list as potentially trustworthy, so `navigator.serviceWorker` is `undefined`
 * and `crypto.randomUUID` does not exist — not "fails", but is simply absent from the API
 * surface. A VPN encrypts the wire and changes nothing about what the browser is willing to
 * treat as secure.
 *
 * That matters because the failure is otherwise invisible. `registration.ts` catches the
 * worker rejection and carries on, and the app behaves perfectly normally: the driver can
 * still complete stops, the queue still works in memory, and nothing ever tells anyone that
 * the shell will not load offline or that the queue dies with the tab. The one requirement
 * that is "the entire reason it is a PWA" fails quietly on every device in the fleet.
 *
 * So the answer is not to hide it and not to break the app. It is to say, in the one place a
 * driver looks, that offline mode is off and what to do about it.
 */

export interface OfflineCapability {
  ok: boolean;
  /** One sentence, in the app's voice, safe to show a driver. */
  headline: string;
  /** What would have to be true for this to be ok. For the settings screen, not the truck. */
  remedy: string;
}

export interface OfflineHealth {
  secureContext: OfflineCapability;
  serviceWorker: OfflineCapability;
  indexedDB: OfflineCapability;
  /** False when the shell will not survive closing the app. The queue still works. */
  canWorkOffline: boolean;
  /** False when the queue will not survive closing the app. */
  canRememberWrites: boolean;
}

const NOT_SECURE: OfflineCapability = {
  ok: false,
  headline: 'Offline mode is off: this address is not secure.',
  remedy:
    'The browser only stores an offline app over HTTPS or localhost. A VPN encrypts the '
    + 'network path but does not make an http:// address secure, so serve this app over TLS '
    + 'with a certificate the device trusts — a private CA installed on the handsets, or a '
    + 'real certificate on an internal hostname.',
};

function evaluate(win: Window | undefined, idb: unknown): OfflineHealth {
  const secure = Boolean(win?.isSecureContext);

  const secureContext: OfflineCapability = secure
    ? { ok: true, headline: 'Secure context.', remedy: '' }
    : NOT_SECURE;

  const hasSw = Boolean(win && 'serviceWorker' in win.navigator && win.navigator.serviceWorker);
  const serviceWorker: OfflineCapability = hasSw
    ? { ok: true, headline: 'The app can be cached for offline use.', remedy: '' }
    : {
      // Distinct from the one above, because it is not always the same fault: a browser can
      // be on HTTPS and still have the worker blocked, and "get HTTPS" would be wrong advice.
      ok: false,
      headline: 'This browser will not store the app for offline use.',
      remedy: 'Open the app in Chrome or Safari with no content-blocking extension enabled.',
    };

  const hasIdb = typeof idb !== 'undefined' && idb !== null;
  const indexedDB: OfflineCapability = hasIdb
    ? { ok: true, headline: 'Writes are kept if the app is closed.', remedy: '' }
    : {
      ok: false,
      headline: 'Unsent work is kept only until this tab closes.',
      remedy: 'Use a current browser. Private/incognito windows also refuse to store anything.',
    };

  return {
    secureContext,
    serviceWorker,
    indexedDB,
    canWorkOffline: secure && hasSw,
    canRememberWrites: hasIdb,
  };
}

/** Read once at startup. Nothing here changes during a session except by a page reload. */
export function offlineHealth(): OfflineHealth {
  const w = typeof window !== 'undefined' ? window : undefined;
  const idb = typeof indexedDB !== 'undefined' ? indexedDB : undefined;
  return evaluate(w, idb);
}

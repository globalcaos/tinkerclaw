import { afterEach, beforeEach, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { getSafeLocalStorage, getSafeSessionStorage } from "../../local-storage.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import "../app.ts";
import type { OpenClawApp } from "../app.ts";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;

  addEventListener() {}

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  send() {}
}

function createMatchMediaMock(matches = true): typeof window.matchMedia {
  return ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

export function mountApp(pathname: string) {
  window.history.replaceState({}, "", pathname);
  const app = document.createElement("openclaw-app") as OpenClawApp;
  document.body.append(app);
  app.connected = true;
  app.requestUpdate();
  return app;
}

export function registerAppMountHooks() {
  beforeEach(async () => {
    window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = undefined;
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    const matchMedia = createMatchMediaMock(true);
    vi.stubGlobal("matchMedia", matchMedia);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: matchMedia,
    });
    getSafeLocalStorage()?.clear();
    getSafeSessionStorage()?.clear();
    document.body.innerHTML = "";
    await i18n.setLocale("en");
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
    );
  });

  afterEach(async () => {
    window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = undefined;
    getSafeLocalStorage()?.clear();
    getSafeSessionStorage()?.clear();
    document.body.innerHTML = "";
    await i18n.setLocale("en");
    vi.unstubAllGlobals();
  });
}

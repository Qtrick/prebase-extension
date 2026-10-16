import type { WebviewToHost } from '@prebase/protocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    // Prefer host-injected API; preview-mock may install this before React mounts.
    if (typeof acquireVsCodeApi === 'function') {
      api = acquireVsCodeApi();
    } else if (typeof (window as unknown as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi === 'function') {
      api = (window as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi();
    } else {
      // Vitest fallback
      api = {
        postMessage: () => undefined,
        getState: () => undefined,
        setState: () => undefined,
      };
    }
  }
  return api;
}

export function postToHost(message: WebviewToHost): void {
  getVsCodeApi().postMessage(message);
}

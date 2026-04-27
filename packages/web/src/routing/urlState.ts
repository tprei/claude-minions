import type { ViewKind } from "./parseUrl.js";

export interface UrlStatePartial {
  connectionId?: string | null;
  view?: ViewKind;
  sessionSlug?: string | null;
  query?: Record<string, string>;
}

export const URL_CHANGE_EVENT = "urlchange";

function buildPath(state: UrlStatePartial): string {
  const connId = state.connectionId;
  if (!connId) return "/";
  const view = state.view ?? "list";
  const slug = state.sessionSlug;
  let path = `/c/${connId}/${view}`;
  if (slug) path += `/${slug}`;
  if (state.query && Object.keys(state.query).length > 0) {
    const params = new URLSearchParams(state.query);
    path += `?${params.toString()}`;
  }
  return path;
}

export function setUrlState(partial: UrlStatePartial): void {
  const path = buildPath(partial);
  globalThis.history.pushState(null, "", path);
  globalThis.dispatchEvent(new Event(URL_CHANGE_EVENT));
}

export function replaceUrlState(partial: UrlStatePartial): void {
  const path = buildPath(partial);
  globalThis.history.replaceState(null, "", path);
  globalThis.dispatchEvent(new Event(URL_CHANGE_EVENT));
}

export function subscribeUrlChanges(handler: () => void): () => void {
  const onPop = (): void => { handler(); };
  const onCustom = (): void => { handler(); };
  globalThis.addEventListener("popstate", onPop);
  globalThis.addEventListener(URL_CHANGE_EVENT, onCustom);
  return () => {
    globalThis.removeEventListener("popstate", onPop);
    globalThis.removeEventListener(URL_CHANGE_EVENT, onCustom);
  };
}

// Flow is served from both labs.google/fx/.../tools/flow/project/<id> and flow.google.com/project/<id>.
const PROJECT_PATH = /^(.*?(?:\/tools\/flow)?\/project\/[^/]+)(?:\/.*)?$/i;
// Anything below the project root (edit/<asset>, trash, ...) is a sub-view without the prompt bar.
const SUBVIEW_PATH = /^(.*?(?:\/tools\/flow)?\/project\/[^/]+)\/.+$/i;

// Project links only: the account switcher also carries "/project/" inside a continue= parameter.
export const FLOW_PROJECT_LINK_SELECTOR = 'a[href^="/project/"], a[href^="https://flow.google.com/project/"], a[href*="/tools/flow/project/"]';

export function isFlowPageUrl(rawUrl: string): boolean {
  try {
    const { hostname } = new URL(rawUrl);
    return hostname === "labs.google" || hostname === "flow.google.com";
  } catch {
    return false;
  }
}

export function isFlowProjectUrl(rawUrl: string): boolean {
  try {
    return isFlowPageUrl(rawUrl) && PROJECT_PATH.test(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
}

export function canonicalFlowProjectUrl(rawUrl: string): string {
  try {
    if (!isFlowPageUrl(rawUrl)) return rawUrl;
    const url = new URL(rawUrl);
    const match = url.pathname.match(SUBVIEW_PATH);
    if (!match) return rawUrl;
    url.pathname = match[1]!;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return rawUrl;
  }
}

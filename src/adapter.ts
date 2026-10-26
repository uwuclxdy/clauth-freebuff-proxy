import type { ProxyAdapter } from "clauth-proxy-core";

function notImplemented(what: string): never {
  throw new Error(`not implemented: ${what}`);
}

export const adapter: ProxyAdapter = {
  manifest: {
    service: "freebuff",
    display_name: "Freebuff",
    description: "free models via the freebuff CLI's free tier (unofficial)",
    version: "0.0.0",
    capabilities: ["events", "count_tokens"],
    figures: [],
    settings: [],
    actions: [],
    usage_cadence_ms: 60_000,
  },

  loginStart: () => notImplemented("loginStart"),
  loginPoll: () => notImplemented("loginPoll"),
  loginPaste: () => notImplemented("loginPaste"),
  loginCancel: () => notImplemented("loginCancel"),
  forward: () => notImplemented("forward"),
  readFigures: () => notImplemented("readFigures"),
  runAction: () => notImplemented("runAction"),
  dropLogin: () => notImplemented("dropLogin"),
};

export type Route = {
  cwd: string;
  label: string;
};

export const ROUTES: Readonly<Record<string, Route>> = {
  // #kt-claude-chat (kupatikana repos)
  C0AVD7BH4PL: { cwd: "/Users/rozzum/git/kupatikana", label: "kupatikana" },

  // #mp-claude-chat (my-pensieve repos)
  C0B0CBB0MJ5: { cwd: "/Users/rozzum/git/my-pensieve", label: "my-pensieve" },

  // #opt-claude-chat (onepointtwocapital repos)
  C0B0TNAEXFA: { cwd: "/Users/rozzum/git/onepointtwocapital", label: "onepointtwocapital" },
};

export const ALLOWED_USERS: ReadonlySet<string> = new Set([
  "U0M2EE1LZ", // maplion
]);

export function getRoute(channelId: string): Route | undefined {
  return ROUTES[channelId];
}

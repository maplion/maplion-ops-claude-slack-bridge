export type Route = {
  cwd: string;
  label: string;
};

export const ROUTES: Readonly<Record<string, Route>> = {
  // kt-claude-chat (kupatikana)
  C0AVD7BH4PL: { cwd: "/Users/rozzum/git/kupatikana", label: "kupatikana" },

  // Add more channels here as you create them:
  // "C…": { cwd: "/Users/rozzum/git/my-pensieve",        label: "my-pensieve" },
  // "C…": { cwd: "/Users/rozzum/git/onepointtwocapital", label: "onepointtwocapital" },
};

export const ALLOWED_USERS: ReadonlySet<string> = new Set([
  "U0M2EE1LZ", // maplion
]);

export function getRoute(channelId: string): Route | undefined {
  return ROUTES[channelId];
}

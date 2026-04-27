import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import dotenv from "dotenv";
import { ROUTES, ALLOWED_USERS, getRoute, type Route } from "./routes.js";
import { AsyncQueue } from "./async-queue.js";

dotenv.config();

const SLACK_BOT_TOKEN = required("SLACK_BOT_TOKEN");
const SLACK_APP_TOKEN = required("SLACK_APP_TOKEN");
// ANTHROPIC_API_KEY is optional. When unset, the underlying Claude Code CLI
// falls back to OAuth credentials in ~/.claude/ (your Pro/Max subscription).
const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MIN ?? 30) * 60 * 1000;

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

type ThreadSession = {
  threadTs: string;
  channel: string;
  route: Route;
  inputQueue: AsyncQueue<SDKUserMessage>;
  query: Query;
  pumpPromise: Promise<void>;
  lastActivity: number;
};

const sessions = new Map<string, ThreadSession>();
let BOT_USER_ID = "";
let BOT_MENTION_RE: RegExp | null = null;

app.event("app_mention", async ({ event, client }) => {
  const route = getRoute(event.channel);
  if (!route) return;
  if (!event.user || !ALLOWED_USERS.has(event.user)) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts ?? event.ts,
      text: `Sorry <@${event.user ?? "user"}>, only the operator can invoke me here.`,
    });
    return;
  }
  const threadTs = event.thread_ts ?? event.ts;
  const text = stripMentions(event.text);
  await sendToSession({
    client,
    channel: event.channel,
    threadTs,
    route,
    text,
  });
});

app.message(async ({ message, client }) => {
  if (message.subtype) return;
  if (!("user" in message) || !("text" in message)) return;
  if (!message.user || !message.text) return;
  if (message.user === BOT_USER_ID) return;
  if (!ALLOWED_USERS.has(message.user)) return;

  const threadTs = "thread_ts" in message ? message.thread_ts : undefined;
  if (!threadTs) return; // only thread replies; first @mentions go through app_mention

  // Skip if this is an @mention — it's already handled by app_mention
  if (BOT_MENTION_RE && BOT_MENTION_RE.test(message.text)) return;

  const session = sessions.get(threadTs);
  if (!session) return; // not a thread we manage

  const text = stripMentions(message.text);
  await sendToSession({
    client,
    channel: session.channel,
    threadTs,
    route: session.route,
    text,
  });
});

async function sendToSession(args: {
  client: WebClient;
  channel: string;
  threadTs: string;
  route: Route;
  text: string;
}): Promise<void> {
  const { client, channel, threadTs, route, text } = args;
  if (!text.trim()) return;

  const session = sessions.get(threadTs) ?? createSession({ client, channel, threadTs, route });
  session.lastActivity = Date.now();
  session.inputQueue.push({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  });
}

function createSession(args: {
  client: WebClient;
  channel: string;
  threadTs: string;
  route: Route;
}): ThreadSession {
  const { client, channel, threadTs, route } = args;
  const inputQueue = new AsyncQueue<SDKUserMessage>();
  const q = query({
    prompt: inputQueue,
    options: {
      cwd: route.cwd,
      permissionMode: "bypassPermissions",
      model: MODEL,
      systemPrompt: buildSystemPrompt(route, channel, threadTs),
    },
  });
  const session: ThreadSession = {
    threadTs,
    channel,
    route,
    inputQueue,
    query: q,
    pumpPromise: pumpOutputs(threadTs, q, client, channel),
    lastActivity: Date.now(),
  };
  sessions.set(threadTs, session);
  console.log(`[bridge] session start thread=${threadTs} cwd=${route.cwd}`);
  return session;
}

async function pumpOutputs(
  threadTs: string,
  q: Query,
  client: WebClient,
  channel: string,
): Promise<void> {
  try {
    for await (const msg of q) {
      if (msg.type === "assistant") {
        const text = (msg.message.content as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text!)
          .join("");
        if (text.trim()) {
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: truncate(text, 39000),
          });
        }
      } else if (msg.type === "result") {
        const r = msg as { total_cost_usd?: number; num_turns?: number; duration_ms?: number };
        console.log(
          `[bridge] turn done thread=${threadTs} cost=$${r.total_cost_usd?.toFixed(4) ?? "?"} turns=${r.num_turns ?? "?"} dur=${r.duration_ms ?? "?"}ms`,
        );
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[bridge] pump error thread=${threadTs}`, err);
    await client.chat
      .postMessage({
        channel,
        thread_ts: threadTs,
        text: `:x: Session error: \`${errMsg.slice(0, 500)}\``,
      })
      .catch(() => {});
  } finally {
    sessions.delete(threadTs);
    console.log(`[bridge] session end thread=${threadTs}`);
  }
}

function buildSystemPrompt(route: Route, channel: string, threadTs: string): string {
  return [
    `You are Claude operating remotely via Slack.`,
    `Working directory: ${route.cwd} (${route.label}).`,
    `Channel ID: ${channel}. Thread TS: ${threadTs}.`,
    ``,
    `Each text response you produce will be posted as a separate message in this Slack thread.`,
    `Use Slack mrkdwn formatting: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`, > quotes, line breaks.`,
    `Do NOT use markdown headers (# ##), tables, or task lists — they don't render in Slack.`,
    `Keep replies concise. The user is reading on a phone or laptop, not a terminal.`,
    ``,
    `When you need to ask the user a question, just write it in plain text. Their next thread reply becomes your next user message — the session stays alive until idle.`,
  ].join("\n");
}

function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 50) + "\n\n_…(truncated)_";
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

async function main(): Promise<void> {
  const auth = await app.client.auth.test();
  BOT_USER_ID = auth.user_id ?? "";
  if (!BOT_USER_ID) throw new Error("Could not resolve bot user ID from auth.test()");
  BOT_MENTION_RE = new RegExp(`<@${BOT_USER_ID}>`);

  await app.start();
  console.log(
    `[bridge] running. model=${MODEL}, bot=${BOT_USER_ID}, idle_timeout=${IDLE_TIMEOUT_MS / 60000}min, channels=[${Object.keys(ROUTES).join(", ")}]`,
  );
}

main().catch((err) => {
  console.error("[bridge] fatal", err);
  process.exit(1);
});

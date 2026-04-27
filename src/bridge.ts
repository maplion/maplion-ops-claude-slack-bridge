import { App } from "@slack/bolt";
import { query } from "@anthropic-ai/claude-agent-sdk";
import dotenv from "dotenv";
import { ROUTES, ALLOWED_USERS, getRoute, type Route } from "./routes.js";

dotenv.config();

const SLACK_BOT_TOKEN = required("SLACK_BOT_TOKEN");
const SLACK_APP_TOKEN = required("SLACK_APP_TOKEN");
// ANTHROPIC_API_KEY is optional. When unset, the underlying Claude Code CLI
// falls back to OAuth credentials in ~/.claude/ (your Pro/Max subscription).
const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

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
  await runClaude({
    client,
    channel: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    userId: event.user,
    route,
  });
});

app.message(async ({ message, client }) => {
  if (message.subtype) return;
  if (message.channel_type !== "im") return;
  if (!("user" in message) || !("text" in message)) return;
  await client.chat.postMessage({
    channel: message.channel,
    text: "DMs aren't routed. @mention me in a routed channel (e.g. #kt-claude-chat).",
  });
});

async function runClaude(args: {
  client: App["client"];
  channel: string;
  threadTs: string;
  userId: string;
  route: Route;
}): Promise<void> {
  const { client, channel, threadTs, userId, route } = args;

  const placeholder = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `:hourglass_flowing_sand: _Working in *${route.label}* (\`${route.cwd}\`)..._`,
  });
  const placeholderTs = placeholder.ts;
  if (!placeholderTs) return;

  try {
    const replies = await client.conversations.replies({ channel, ts: threadTs, limit: 50 });
    const prompt = buildPrompt(replies.messages ?? [], placeholderTs);
    if (!prompt.trim()) {
      await client.chat.update({ channel, ts: placeholderTs, text: "(empty prompt)" });
      return;
    }

    let answer = "";
    for await (const msg of query({
      prompt,
      options: {
        cwd: route.cwd,
        permissionMode: "bypassPermissions",
        model: MODEL,
        systemPrompt: [
          `You are operating remotely via Slack on behalf of <@${userId}>.`,
          `Working directory: ${route.cwd} (${route.label}).`,
          `Keep replies concise. Use Slack mrkdwn (*bold*, \`code\`, line breaks) — not markdown headers or tables.`,
        ].join("\n"),
      },
    })) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") answer += block.text;
        }
      }
    }

    const final = answer.trim() || "_(no text response)_";
    await client.chat.update({ channel, ts: placeholderTs, text: truncate(final, 39000) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[bridge] error", err);
    await client.chat.update({
      channel,
      ts: placeholderTs,
      text: `:x: Error: \`${msg.slice(0, 500)}\``,
    });
  }
}

function buildPrompt(
  messages: ReadonlyArray<{ user?: string; text?: string; ts?: string }>,
  excludeTs: string,
): string {
  return messages
    .filter((m) => m.ts !== excludeTs && m.text)
    .map((m) => `<@${m.user ?? "unknown"}>: ${stripMentions(m.text!)}`)
    .join("\n");
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

await app.start();
console.log(`[bridge] running. model=${MODEL}, channels=[${Object.keys(ROUTES).join(", ")}]`);

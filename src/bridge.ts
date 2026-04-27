import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import dotenv from "dotenv";
import { ROUTES, ALLOWED_USERS, getRoute, type Route } from "./routes.js";
import { AsyncQueue } from "./async-queue.js";
import { SessionStore, type ThreadRef } from "./session-store.js";

dotenv.config();

const SLACK_BOT_TOKEN = required("SLACK_BOT_TOKEN");
const SLACK_APP_TOKEN = required("SLACK_APP_TOKEN");
// ANTHROPIC_API_KEY is optional. When unset, the underlying Claude Code CLI
// falls back to OAuth credentials in ~/.claude/ (your Pro/Max subscription).
const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MIN ?? 30) * 60 * 1000;

const RESET_RE = /^\s*!(clear|reset|end|new)\b/i;
const STOP_RE = /^\s*!stop\b/i;
const LOG_LEVEL = (process.env.BRIDGE_LOG_LEVEL ?? "info").toLowerCase() as "info" | "debug";

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
const store = new SessionStore();
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
  if (await maybeHandleResetCommand({ client, channel: event.channel, threadTs, text })) return;
  if (await maybeHandleStopCommand({ client, channel: event.channel, threadTs, text })) return;
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

  // For replies in threads, route can come from in-memory session OR from store
  const liveSession = sessions.get(threadTs);
  const ref = liveSession ? null : store.get(threadTs);
  let route: Route | null = null;
  let channel: string;
  if (liveSession) {
    route = liveSession.route;
    channel = liveSession.channel;
  } else if (ref) {
    // Resume from store: validate the route still exists and the cwd matches
    const r = getRoute(ref.channel);
    if (!r || r.cwd !== ref.cwd) {
      console.warn(`[bridge] stale ref thread=${threadTs} — channel route changed; ignoring`);
      return;
    }
    route = r;
    channel = ref.channel;
  } else {
    return; // not a thread we manage
  }

  const text = stripMentions(message.text);
  if (await maybeHandleResetCommand({ client, channel, threadTs, text })) return;
  if (await maybeHandleStopCommand({ client, channel, threadTs, text })) return;
  await sendToSession({ client, channel, threadTs, route, text });
});

async function maybeHandleResetCommand(args: {
  client: WebClient;
  channel: string;
  threadTs: string;
  text: string;
}): Promise<boolean> {
  const { client, channel, threadTs, text } = args;
  if (!RESET_RE.test(text)) return false;

  const live = sessions.get(threadTs);
  if (live) {
    live.inputQueue.close();
    void live.query.interrupt().catch(() => {});
    sessions.delete(threadTs);
  }
  store.delete(threadTs);

  await client.chat
    .postMessage({
      channel,
      thread_ts: threadTs,
      text: `:broom: _Session cleared. Your next message starts a fresh Claude context._`,
    })
    .catch(() => {});
  console.log(`[bridge] reset thread=${threadTs}`);
  return true;
}

async function maybeHandleStopCommand(args: {
  client: WebClient;
  channel: string;
  threadTs: string;
  text: string;
}): Promise<boolean> {
  const { client, channel, threadTs, text } = args;
  if (!STOP_RE.test(text)) return false;

  const live = sessions.get(threadTs);
  if (!live) {
    await client.chat
      .postMessage({
        channel,
        thread_ts: threadTs,
        text: `:information_source: _No active task to stop. Send a new message to continue._`,
      })
      .catch(() => {});
    return true;
  }

  await live.query
    .interrupt()
    .catch((err) => console.error(`[bridge] interrupt failed thread=${threadTs}`, err));
  await client.chat
    .postMessage({
      channel,
      thread_ts: threadTs,
      text: `:octagonal_sign: _Stopped current task. Session preserved — send your next message to continue._`,
    })
    .catch(() => {});
  console.log(`[bridge] stop thread=${threadTs}`);
  return true;
}

async function sendToSession(args: {
  client: WebClient;
  channel: string;
  threadTs: string;
  route: Route;
  text: string;
}): Promise<void> {
  const { client, channel, threadTs, route, text } = args;
  if (!text.trim()) return;

  let session = sessions.get(threadTs);
  if (!session) {
    const ref = store.get(threadTs);
    const resumeFrom = ref?.sessionId ?? null;
    session = createSession({ client, channel, threadTs, route, resumeFrom });
  }
  session.lastActivity = Date.now();
  // Mirror lastActivity to the store so idle accounting survives a restart
  const ref = store.get(threadTs);
  if (ref) {
    ref.lastActivity = session.lastActivity;
    ref.status = "active";
    store.upsert(ref);
  }
  try {
    session.inputQueue.push(makeUserMessage(text));
  } catch {
    // Session was closing; start a fresh one and retry once.
    sessions.delete(threadTs);
    session = createSession({ client, channel, threadTs, route, resumeFrom: null });
    session.inputQueue.push(makeUserMessage(text));
  }
}

function makeUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  };
}

function createSession(args: {
  client: WebClient;
  channel: string;
  threadTs: string;
  route: Route;
  resumeFrom: string | null;
}): ThreadSession {
  const { client, channel, threadTs, route, resumeFrom } = args;
  const inputQueue = new AsyncQueue<SDKUserMessage>();
  const q = query({
    prompt: inputQueue,
    options: {
      cwd: route.cwd,
      permissionMode: "bypassPermissions",
      model: MODEL,
      // AskUserQuestion would block forever — the SDK has no path to a human.
      // Disable it; the system prompt tells Claude to ask via plain text instead.
      disallowedTools: ["AskUserQuestion"],
      systemPrompt: buildSystemPrompt(route, channel, threadTs),
      ...(resumeFrom ? { resume: resumeFrom } : {}),
    },
  });
  const session: ThreadSession = {
    threadTs,
    channel,
    route,
    inputQueue,
    query: q,
    pumpPromise: pumpOutputs(threadTs, q, client, channel, resumeFrom !== null),
    lastActivity: Date.now(),
  };
  sessions.set(threadTs, session);

  // Upsert the ref now (sessionId still null until first SDK message); ensures
  // we don't lose the thread if the bridge dies before the first message lands.
  const existing = store.get(threadTs);
  const ref: ThreadRef = existing ?? {
    threadTs,
    channel,
    cwd: route.cwd,
    sessionId: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    status: "active",
  };
  ref.status = "active";
  ref.lastActivity = Date.now();
  store.upsert(ref);

  blog(
    threadTs,
    "info",
    `session ${resumeFrom ? "resumed" : "start"} cwd=${route.cwd}${resumeFrom ? ` from=${resumeFrom}` : ""}`,
  );
  return session;
}

async function pumpOutputs(
  threadTs: string,
  q: Query,
  client: WebClient,
  channel: string,
  isResume: boolean,
): Promise<void> {
  let sessionIdCaptured = false;
  try {
    for await (const msg of q) {
      // Capture session_id from the first message that has one
      if (!sessionIdCaptured) {
        const sid = (msg as { session_id?: string }).session_id;
        if (sid) {
          sessionIdCaptured = true;
          const ref = store.get(threadTs);
          if (ref && ref.sessionId !== sid) {
            ref.sessionId = sid;
            ref.lastActivity = Date.now();
            store.upsert(ref);
            blog(threadTs, "info", `session_id sid=${sid}`);
          }
        }
      }

      if (msg.type === "assistant") {
        const blocks = msg.message.content as Array<{
          type: string;
          text?: string;
          name?: string;
          input?: unknown;
        }>;
        let textBuf = "";
        for (const block of blocks) {
          if (block.type === "text" && typeof block.text === "string") {
            textBuf += block.text;
          } else if (block.type === "tool_use" && block.name) {
            blog(threadTs, "info", `tool ${block.name}(${briefArgs(block.input)})`);
          }
        }
        if (textBuf.trim()) {
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: truncate(textBuf, 39000),
          });
        }
      } else if (msg.type === "user") {
        const tur = (msg as { tool_use_result?: unknown }).tool_use_result;
        if (tur !== undefined) {
          const size = typeof tur === "string" ? tur.length : JSON.stringify(tur).length;
          blog(threadTs, "info", `result ${size}c`);
          if (LOG_LEVEL === "debug") {
            const preview = (typeof tur === "string" ? tur : JSON.stringify(tur)).slice(0, 240);
            blog(threadTs, "debug", `result.preview ${preview.replace(/\n/g, "↵")}`);
          }
        }
      } else if (msg.type === "result") {
        const r = msg as { total_cost_usd?: number; num_turns?: number; duration_ms?: number };
        blog(
          threadTs,
          "info",
          `turn done cost=$${r.total_cost_usd?.toFixed(4) ?? "?"} turns=${r.num_turns ?? "?"} dur=${r.duration_ms ?? "?"}ms`,
        );
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[bridge] pump error thread=${threadTs}`, err);
    // If a resume failed because the underlying session is gone, drop the ref so
    // the next message starts fresh instead of looping on the same broken resume.
    if (isResume && /session.*(not found|missing|invalid)/i.test(errMsg)) {
      console.warn(`[bridge] resume failed, clearing ref thread=${threadTs}`);
      store.delete(threadTs);
    }
    await client.chat
      .postMessage({
        channel,
        thread_ts: threadTs,
        text: `:x: Session error: \`${errMsg.slice(0, 500)}\``,
      })
      .catch(() => {});
  } finally {
    sessions.delete(threadTs);
    const ref = store.get(threadTs);
    if (ref) {
      ref.status = "idle";
      store.upsert(ref);
    }
    blog(threadTs, "info", "session unloaded");
  }
}

function buildSystemPrompt(route: Route, channel: string, threadTs: string): string {
  return [
    `You are Claude operating remotely via Slack.`,
    `Working directory: ${route.cwd} (${route.label}).`,
    `Channel ID: ${channel}. Thread TS: ${threadTs}.`,
    ``,
    `OUTPUT FORMAT`,
    `Each text response you produce becomes a separate Slack message in this thread.`,
    `Use Slack mrkdwn: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`, > quotes, line breaks.`,
    `Do NOT use markdown headers (# ##), tables, or task lists — Slack does not render them.`,
    `Keep replies concise. The user is on Slack, not a terminal.`,
    ``,
    `ASKING QUESTIONS`,
    `The AskUserQuestion tool is DISABLED in this environment.`,
    `When you need to ask the user something — including when a skill or agent instructs you to use AskUserQuestion — write the question in plain text instead. End your message with the question.`,
    `Your session stays alive: the user's next thread reply becomes your next user message. You can multi-turn freely.`,
    `If a skill expects multi-choice answers, list options inline like \`A) foo  B) bar  C) baz\` and ask the user to reply with a letter.`,
    ``,
    `LONG-RUNNING WORK`,
    `For multi-step tasks (e.g., GSD workflows), post brief progress updates as you complete steps so the user can follow along. Don't go silent for minutes at a time.`,
    `If a step fails, surface the error in the thread — don't just log it.`,
    ``,
    `SESSION CONTROL`,
    `The user can type !clear (also !reset, !end, !new) at any time to wipe context and start a fresh Claude session in this same thread. After GSD plan/execute phases complete, suggest the user run !clear before the next phase to keep context clean.`,
    `The user can type !stop to abort your current turn without clearing the session. After !stop, your next user message resumes the conversation with full context intact. If a long task is going off-track, suggest the user type !stop and try again with adjusted instructions.`,
  ].join("\n");
}

function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
}

function fmtTs(): string {
  return new Date().toISOString().slice(11, 19);
}

function blog(threadTs: string, level: "info" | "debug", msg: string): void {
  if (level === "debug" && LOG_LEVEL !== "debug") return;
  const tag = level === "debug" ? "[debug]" : "[bridge]";
  console.log(`${fmtTs()} ${tag} thread=${threadTs} ${msg}`);
}

function briefArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  if (typeof i.file_path === "string") return `path=${shortPath(i.file_path)}`;
  if (typeof i.path === "string") return `path=${shortPath(i.path)}`;
  if (typeof i.command === "string") return `cmd=${truncate(i.command, 80)}`;
  if (typeof i.pattern === "string") return `pattern=${truncate(i.pattern, 60)}`;
  if (typeof i.prompt === "string") return `prompt="${truncate(i.prompt, 60)}"`;
  if (typeof i.url === "string") return `url=${truncate(i.url, 80)}`;
  if (typeof i.query === "string") return `query="${truncate(i.query, 60)}"`;
  if (typeof i.subagent_type === "string") return `agent=${i.subagent_type}`;
  if (typeof i.skill === "string") return `skill=${i.skill}`;
  return Object.keys(i).slice(0, 3).join(",");
}

function shortPath(p: string): string {
  return p.length > 60 ? "…" + p.slice(-57) : p;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 50) + "\n\n_…(truncated)_";
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function sweepIdleSessions(client: WebClient): void {
  const now = Date.now();
  for (const [threadTs, session] of sessions.entries()) {
    if (now - session.lastActivity < IDLE_TIMEOUT_MS) continue;
    console.log(`[bridge] idle pause thread=${threadTs}`);
    session.inputQueue.close();
    void session.query.interrupt().catch(() => {});
    // Mark idle in the store (mapping kept for resume on next reply)
    const ref = store.get(threadTs);
    if (ref) {
      ref.status = "idle";
      store.upsert(ref);
    }
    void client.chat
      .postMessage({
        channel: session.channel,
        thread_ts: threadTs,
        text: `:zzz: _Session paused after ${IDLE_TIMEOUT_MS / 60000} min idle — your next reply will resume it._`,
      })
      .catch(() => {});
  }
}

async function shutdown(reason: string): Promise<void> {
  console.log(`[bridge] shutdown (${reason}); closing ${sessions.size} live session(s)`);
  for (const [threadTs, session] of sessions.entries()) {
    session.inputQueue.close();
    void session.query.interrupt().catch(() => {});
    const ref = store.get(threadTs);
    if (ref) {
      ref.status = "idle";
      store.upsert(ref);
    }
  }
  // Give pumps a moment to drain
  await new Promise((r) => setTimeout(r, 500));
  await store.flush().catch((e) => console.error("[bridge] store flush failed:", e));
  await store.releaseLock();
  process.exit(0);
}

async function main(): Promise<void> {
  await store.init();

  const auth = await app.client.auth.test();
  BOT_USER_ID = auth.user_id ?? "";
  if (!BOT_USER_ID) throw new Error("Could not resolve bot user ID from auth.test()");
  BOT_MENTION_RE = new RegExp(`<@${BOT_USER_ID}>`);

  await app.start();
  console.log(
    `[bridge] running. model=${MODEL}, bot=${BOT_USER_ID}, idle_timeout=${IDLE_TIMEOUT_MS / 60000}min, log_level=${LOG_LEVEL}, channels=[${Object.keys(ROUTES).join(", ")}], persisted_threads=${store.size()}`,
  );

  // Idle sweep every minute
  const sweepTimer = setInterval(() => sweepIdleSessions(app.client), 60_000);
  sweepTimer.unref();

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[bridge] fatal", err);
  process.exit(1);
});

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { WebClient } from "@slack/web-api";
import { z } from "zod";

/**
 * Pending-resolver shape: when Claude calls slack_ask, the handler awaits a
 * Promise that gets resolved (or rejected) by the bridge's message handler
 * when the user replies in the thread.
 */
export type AskResolver = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
};

/**
 * Builds an in-process MCP server that exposes `slack_ask`. Each Slack thread
 * gets its own instance so the handler captures the thread/channel context.
 *
 * The flow:
 *   1. Claude calls slack_ask({ question, options? })
 *   2. The handler posts a formatted question to the Slack thread
 *   3. The handler awaits a Promise registered via registerPending()
 *   4. When the user replies in the thread, the bridge resolves that Promise
 *      with the reply text
 *   5. The handler returns the text as the tool result; Claude continues
 */
export function buildSlackAskMcp(args: {
  threadTs: string;
  channel: string;
  client: WebClient;
  registerPending: (resolver: AskResolver) => void;
  log: (msg: string) => void;
}) {
  const { threadTs, channel, client, registerPending, log } = args;

  return createSdkMcpServer({
    name: "slack-ux",
    version: "1.0.0",
    tools: [
      tool(
        "slack_ask",
        [
          "Ask the user a question via Slack and pause until they reply in the thread.",
          "Use this whenever you would normally call AskUserQuestion (which is disabled in this environment).",
          "The user's next thread reply becomes the tool result.",
          "Prefer this over plain-text questions when the answer needs to be structured (multi-choice, yes/no, etc.) — it renders cleanly in Slack.",
        ].join(" "),
        {
          question: z.string().describe("The question to ask the user."),
          options: z
            .array(
              z.object({
                label: z.string().describe("Short label for this choice."),
                description: z.string().optional().describe("Optional fuller explanation."),
              }),
            )
            .optional()
            .describe(
              "Optional multiple-choice options. The user can reply with the letter (A, B, …), the label, or a freeform answer.",
            ),
          context: z
            .string()
            .optional()
            .describe("Optional italicized context shown above the question (e.g. why you need to know)."),
          header: z
            .string()
            .optional()
            .describe("Optional bold header shown at the top of the message (e.g. topic name)."),
        },
        async (input) => {
          const text = formatPrompt(input);
          await client.chat.postMessage({ channel, thread_ts: threadTs, text });
          log(`slack_ask waiting q="${truncate(input.question, 60)}"`);
          try {
            const answer = await new Promise<string>((resolve, reject) => {
              registerPending({ resolve, reject });
            });
            log(`slack_ask answered "${truncate(answer, 60)}"`);
            return { content: [{ type: "text" as const, text: answer }] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log(`slack_ask aborted: ${msg}`);
            return {
              isError: true,
              content: [{ type: "text" as const, text: `User did not answer: ${msg}` }],
            };
          }
        },
      ),
    ],
  });
}

function formatPrompt(input: {
  question: string;
  options?: Array<{ label: string; description?: string }>;
  context?: string;
  header?: string;
}): string {
  const parts: string[] = [];
  if (input.header) parts.push(`*${input.header}*`);
  if (input.context) parts.push(`_${input.context}_`);
  parts.push(`:question: ${input.question}`);
  if (input.options && input.options.length > 0) {
    const lines = input.options.map((o, i) => {
      const letter = String.fromCharCode(65 + i);
      return o.description ? `*${letter})* ${o.label} — _${o.description}_` : `*${letter})* ${o.label}`;
    });
    parts.push(lines.join("\n"));
    parts.push(`_Reply with a letter, the label, or your own answer._`);
  } else {
    parts.push(`_Reply in this thread to answer._`);
  }
  return parts.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

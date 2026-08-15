/**
 * Telegram webhook: send a .fit file to the bot, it lands in Garmin Connect.
 *
 * Always answers 200 quickly — Telegram retries any non-2xx, and a retry here
 * means a second upload attempt of the same activity. The actual work runs in
 * ctx.waitUntil and reports back over sendMessage.
 */
import { uploadFit, type GarminEnv } from "./garmin";

interface Env extends GarminEnv {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_SECRET: string;
  /** Comma-separated Telegram user ids allowed to upload. */
  TELEGRAM_ALLOWED_IDS: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface Doc {
  file_id: string;
  file_name?: string;
  file_size?: number;
}

async function tg(env: Env, method: string, payload: unknown): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!body.ok) throw new Error(`telegram ${method}: ${body.description}`);
  return body.result;
}

const reply = (env: Env, chatId: number, text: string) =>
  tg(env, "sendMessage", { chat_id: chatId, text }).catch(() => {
    // Nothing left to report the failure *to*. Swallow so waitUntil stays quiet.
  });

async function handle(env: Env, chatId: number, doc: Doc) {
  const name = doc.file_name ?? "activity.fit";
  try {
    // getFile refuses anything over 20MB — that's a Bot API limit, not ours.
    const file = await tg(env, "getFile", { file_id: doc.file_id });
    const res = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`,
    );
    if (!res.ok) throw new Error(`下載失敗 ${res.status}`);

    const result = await uploadFit(env, new Uint8Array(await res.arrayBuffer()), name);
    if (result.duplicate) return reply(env, chatId, `⚠️ ${name}\n這筆活動已經存在了`);

    const link = result.activityId
      ? `\nhttps://connect.garmin.com/modern/activity/${result.activityId}`
      : "";
    await reply(env, chatId, `✅ ${name} 已匯入${link}`);
  } catch (e) {
    // Decision 12: no retry. Surface the real message so it's actionable.
    await reply(env, chatId, `❌ ${name}\n${(e as Error).message}`);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // This endpoint is world-reachable and holds Garmin credentials. Fail closed
    // rather than leave a "forgot to set the secret" hole.
    if (!env.TELEGRAM_SECRET || !env.TELEGRAM_ALLOWED_IDS) {
      return new Response("not configured", { status: 500 });
    }
    if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    const message = ((await request.json()) as any)?.message;
    if (!message?.chat?.id) return new Response("ok");

    // Second layer: the secret proves the request came from Telegram, not that it
    // came from me. Anyone who finds the bot can message it.
    if (!env.TELEGRAM_ALLOWED_IDS.split(",").includes(String(message.from?.id))) {
      return new Response("ok");
    }

    const doc: Doc | undefined = message.document;
    if (!doc?.file_name?.toLowerCase().endsWith(".fit")) {
      ctx.waitUntil(reply(env, message.chat.id, "請以檔案（document）方式傳送 .fit 檔"));
      return new Response("ok");
    }

    ctx.waitUntil(handle(env, message.chat.id, doc));
    return new Response("ok");
  },
};

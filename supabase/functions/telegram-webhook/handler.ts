export interface Config {
  botToken: string;
  botId: number;
  botUsername: string;
  webhookSecret: string;
  webAppUrl: string;
  supabaseUrl: string;
  adminKey: string;
}

export interface User {
  user_id: number;
  name: string;
}

export interface Reply {
  chat_id: number;
  text: string;
  reply_markup: {
    inline_keyboard: { text: string; web_app: { url: string } }[][];
  };
}

export interface Store {
  claim(
    updateId: number,
    owner: string,
  ): Promise<"acquired" | "busy" | "duplicate">;
  upsertUser(user: User): Promise<void>;
  beginSend(updateId: number, owner: string): Promise<void>;
  complete(updateId: number, owner: string): Promise<void>;
  release(updateId: number, owner: string): Promise<void>;
}

export class TelegramRejected extends Error {}

export function loadConfig(env: (name: string) => string | undefined): Config {
  const botToken = env("BOT_TOKEN") || "";
  const botId = Number(botToken.split(":")[0]);
  const botUsername = (env("BOT_USERNAME") || "").replace(/^@/, "");
  const webhookSecret = env("TELEGRAM_WEBHOOK_SECRET") || "";
  const webAppUrl = env("WEB_APP_URL") ||
    "https://beauty-aggregator-indol.vercel.app";
  const supabaseUrl = env("SUPABASE_URL") || "";
  const keys = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}");
  const adminKey = keys.default || env("SUPABASE_SERVICE_ROLE_KEY") || "";

  if (
    !/^[1-9]\d*:[A-Za-z0-9_-]+$/.test(botToken) ||
    !Number.isSafeInteger(botId) || !/^[A-Za-z0-9_]{5,32}$/.test(botUsername) ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret) ||
    typeof adminKey !== "string" || !adminKey
  ) throw new Error("Invalid webhook configuration");

  for (const value of [webAppUrl, supabaseUrl]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("HTTPS URLs without credentials are required");
    }
  }
  return {
    botToken,
    botId,
    botUsername,
    webhookSecret,
    webAppUrl,
    supabaseUrl: supabaseUrl.replace(/\/$/, ""),
    adminKey,
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function command(update: Record<string, unknown>, config: Config) {
  const message = object(update.message);
  if (!message || typeof message.text !== "string") return null;
  const from = object(message.from);
  const chat = object(message.chat);
  // Web App buttons are supported in private chats. Never accept a caller's
  // user_id, chat_id or initDataUnsafe as an identity (BB-01 / BB-05).
  if (
    !from || !chat || from.is_bot !== false || chat.type !== "private" ||
    !positiveId(from.id) || chat.id !== from.id ||
    !positiveId(message.message_id) ||
    typeof from.first_name !== "string" || !from.first_name ||
    (from.last_name !== undefined &&
      typeof from.last_name !== "string")
  ) return null;

  const match = /^\/(start|app|book)(?:@([A-Za-z0-9_]+))?(?=\s|$)/.exec(
    message.text,
  );
  if (
    !match ||
    (match[2] && match[2].toLowerCase() !== config.botUsername.toLowerCase())
  ) return null;

  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  const text = match[1] === "start"
    ? `Привет, ${name}! 💅🏿\n\nДобро пожаловать в BB — сервис онлайн-записи.\n\nОткройте приложение:`
    : match[1] === "app"
    ? "Открыть BB:"
    : "Откройте BB, чтобы выбрать услугу и записаться на слот.";
  return {
    user: match[1] === "start" ? { user_id: from.id, name } : null,
    reply: {
      chat_id: from.id,
      text,
      reply_markup: {
        inline_keyboard: [[{
          text: "Открыть BB",
          web_app: { url: config.webAppUrl },
        }]],
      },
    } satisfies Reply,
  };
}

async function validSecret(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const hashes = await Promise.all(
    [actual, expected].map(async (value) =>
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", encoder.encode(value)),
      )
    ),
  );
  let difference = 0;
  for (let i = 0; i < hashes[0].length; i++) {
    difference |= hashes[0][i] ^ hashes[1][i];
  }
  return difference === 0;
}

async function readUpdate(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65_536) {
        await reader.cancel();
        throw new RangeError("Body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

export function createHandler(
  config: Config,
  store: Store,
  send: (reply: Reply) => Promise<void>,
  log: (event: string, updateId: number) => void = (event, id) =>
    console.error(event, id),
) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }
    const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (
      !secret || secret.length > 256 ||
      !(await validSecret(secret, config.webhookSecret))
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (
      req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
        "application/json"
    ) {
      return new Response("Expected JSON", { status: 415 });
    }
    let update;
    try {
      update = object(await readUpdate(req));
    } catch (error) {
      return new Response("Invalid update", {
        status: error instanceof RangeError ? 413 : 400,
      });
    }
    if (
      !update || typeof update.update_id !== "number" ||
      !Number.isSafeInteger(update.update_id) || update.update_id < 0
    ) return new Response("Invalid update", { status: 400 });

    const action = command(update, config);
    if (!action) return Response.json({ ok: true });
    const updateId = update.update_id;
    const owner = crypto.randomUUID();
    let claimed = false;
    let sending = false;
    try {
      const claim = await store.claim(updateId, owner);
      if (claim === "duplicate") return Response.json({ ok: true });
      if (claim === "busy") return new Response("Retry later", { status: 503 });
      claimed = true;
      if (action.user) await store.upsertUser(action.user);
      // Persist before calling Telegram: retries, including cold starts, must
      // not resend after an ambiguous network failure. Such deliveries need review.
      sending = true;
      await store.beginSend(updateId, owner);
      await send(action.reply);
      await store.complete(updateId, owner);
      return Response.json({ ok: true });
    } catch (error) {
      if (claimed && (!sending || error instanceof TelegramRejected)) {
        try {
          await store.release(updateId, owner);
        } catch {
          log("telegram_webhook_release_failed", updateId);
        }
      }
      log(
        sending && !(error instanceof TelegramRejected)
          ? "telegram_webhook_delivery_uncertain"
          : "telegram_webhook_retryable_failure",
        updateId,
      );
      return new Response("Webhook processing failed", { status: 503 });
    }
  };
}

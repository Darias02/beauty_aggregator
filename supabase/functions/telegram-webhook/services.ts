import {
  type Config,
  type Reply,
  type Store,
  TelegramRejected,
  type User,
} from "./handler.ts";

type Fetch = typeof fetch;

export function createStore(config: Config, request: Fetch = fetch): Store {
  const headers: Record<string, string> = {
    apikey: config.adminKey,
    "Content-Type": "application/json",
  };
  // Secret API keys belong only in apikey; legacy service_role is also a JWT.
  if (!config.adminKey.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${config.adminKey}`;
  }
  async function api(
    path: string,
    body: unknown,
    extra: Record<string, string> = {},
  ) {
    const response = await request(`${config.supabaseUrl}/rest/v1/${path}`, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Webhook database operation failed");
    return response;
  }
  function args(updateId: number, owner: string) {
    return { p_bot_id: config.botId, p_update_id: updateId, p_owner: owner };
  }
  async function transition(
    operation: string,
    updateId: number,
    owner: string,
  ) {
    const response = await api(
      `rpc/telegram_webhook_${operation}`,
      args(updateId, owner),
    );
    if (await response.json() !== true) throw new Error("Webhook claim lost");
  }
  return {
    async claim(updateId, owner) {
      const response = await api(
        "rpc/telegram_webhook_claim",
        args(updateId, owner),
      );
      const result: unknown = await response.json();
      if (
        result !== "acquired" && result !== "busy" && result !== "duplicate"
      ) {
        throw new Error("Invalid webhook claim result");
      }
      return result;
    },
    async upsertUser(user: User) {
      // Register once: preserve names edited through BB-07 and existing phones.
      await api("users?on_conflict=user_id", user, {
        Prefer: "resolution=ignore-duplicates,missing=default,return=minimal",
      });
    },
    beginSend: (id, owner) => transition("begin_send", id, owner),
    complete: (id, owner) => transition("complete", id, owner),
    release: (id, owner) => transition("release", id, owner),
  };
}

export function createSender(config: Config, request: Fetch = fetch) {
  return async (reply: Reply): Promise<void> => {
    const response = await request(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reply),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      },
    );
    // Do not log response bodies, request URLs (which contain the token), or errors.
    const result = await response.json();
    if (result?.ok === false) {
      throw new TelegramRejected("Telegram rejected message");
    }
    if (!response.ok || result?.ok !== true) {
      throw new Error("Unknown Telegram delivery status");
    }
  };
}

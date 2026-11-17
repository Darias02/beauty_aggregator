import { deepStrictEqual as equal, rejects } from "node:assert/strict";
import {
  type Config,
  createHandler,
  loadConfig,
  type Reply,
  type Store,
  TelegramRejected,
  type User,
} from "./handler.ts";

export const config: Config = {
  botToken: "900:test-token",
  botId: 900,
  botUsername: "BeautyBookingBot",
  webhookSecret: "test-webhook-secret-with-32-characters",
  webAppUrl: "https://beauty-aggregator-indol.vercel.app",
  supabaseUrl: "https://test.supabase.co",
  adminKey: "sb_secret_test",
};

function update(text = "/start", id = 1) {
  return {
    update_id: id,
    message: {
      message_id: 10,
      from: {
        id: 42,
        is_bot: false,
        first_name: "Дарья",
        last_name: "Иванова",
      },
      chat: { id: 42, type: "private" },
      text,
    },
  };
}

function request(body: unknown, secret: string | null = config.webhookSecret) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  return new Request("https://example.test/telegram-webhook?user_id=999", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function fixture() {
  const entries = new Map<number, { owner: string; state: string }>();
  const users: User[] = [];
  const replies: Reply[] = [];
  const logs: string[] = [];
  const store: Store = {
    claim(id, owner) {
      const entry = entries.get(id);
      if (entry) {
        return Promise.resolve(
          entry.state === "claimed" ? "busy" : "duplicate",
        );
      }
      entries.set(id, { owner, state: "claimed" });
      return Promise.resolve("acquired");
    },
    upsertUser(user) {
      users.push(user);
      return Promise.resolve();
    },
    beginSend(id) {
      entries.get(id)!.state = "sending";
      return Promise.resolve();
    },
    complete(id) {
      entries.get(id)!.state = "completed";
      return Promise.resolve();
    },
    release(id) {
      entries.delete(id);
      return Promise.resolve();
    },
  };
  const sender = (reply: Reply) => {
    replies.push(reply);
    return Promise.resolve();
  };
  const handler = () =>
    createHandler(config, store, sender, (event) => logs.push(event));
  return { entries, users, replies, store, sender, logs, handler };
}

for (const cmd of ["start", "app", "book"]) {
  Deno.test(`/${cmd}: preserves text, keyboard and registration behavior`, async () => {
    const f = fixture();
    equal((await f.handler()(request(update(`/${cmd}`)))).status, 200);
    equal(
      f.users,
      cmd === "start" ? [{ user_id: 42, name: "Дарья Иванова" }] : [],
    );
    equal(f.replies, [{
      chat_id: 42,
      text: cmd === "start"
        ? "Привет, Дарья Иванова! 💅🏿\n\nДобро пожаловать в BB — сервис онлайн-записи.\n\nОткройте приложение:"
        : cmd === "app"
        ? "Открыть BB:"
        : "Откройте BB, чтобы выбрать услугу и записаться на слот.",
      reply_markup: {
        inline_keyboard: [[{
          text: "Открыть BB",
          web_app: { url: config.webAppUrl },
        }]],
      },
    }]);
  });
}

Deno.test("start payload and own bot mention work; custom URL comes from server", async () => {
  const f = fixture();
  const handler = createHandler(
    { ...config, webAppUrl: "https://example.test/app" },
    f.store,
    f.sender,
  );
  const body = update("/start@beautybookingbot referral_123");
  delete (body.message.from as { last_name?: string }).last_name;
  equal((await handler(request(body))).status, 200);
  equal(f.users, [{ user_id: 42, name: "Дарья" }]);
  equal(
    f.replies[0].reply_markup.inline_keyboard[0][0].web_app.url,
    "https://example.test/app",
  );
});

for (const secret of [null, "", "wrong-secret", "x".repeat(257)]) {
  Deno.test(`unauthorized secret (${secret?.length ?? "missing"}): no side effects`, async () => {
    const f = fixture();
    equal((await f.handler()(request(update(), secret))).status, 401);
    equal(f.entries.size, 0);
    equal(f.users.length + f.replies.length, 0);
  });
}

Deno.test("secret is checked before parsing JSON", async () => {
  const f = fixture();
  const req = new Request("https://example.test", {
    method: "POST",
    body: "{",
  });
  equal((await f.handler()(req)).status, 401);
});

for (const method of ["GET", "OPTIONS", "PUT"]) {
  Deno.test(`rejects ${method}`, async () => {
    equal(
      (await fixture().handler()(
        new Request("https://example.test", { method }),
      )).status,
      405,
    );
  });
}

Deno.test("malformed, non-JSON and oversized requests", async () => {
  const handler = fixture().handler();
  for (
    const [body, type, status] of [
      ["{", "application/json", 400],
      ["{}", "text/plain", 415],
      [" ".repeat(65_537), "application/json", 413],
    ] as const
  ) {
    equal(
      (await handler(
        new Request("https://example.test", {
          method: "POST",
          body,
          headers: {
            "Content-Type": type,
            "X-Telegram-Bot-Api-Secret-Token": config.webhookSecret,
          },
        }),
      )).status,
      status,
    );
  }
  for (
    const body of [null, [], {}, { update_id: -1 }, { update_id: "1" }, {
      update_id: 2 ** 53,
    }]
  ) {
    equal((await handler(request(body))).status, 400);
  }
});

Deno.test("ignores unknown commands, wrong mentions, edits and callbacks", async () => {
  const f = fixture();
  for (
    const body of [
      update("/help"),
      update("/starter"),
      update("hello /start"),
      update("/start@OtherBot"),
      update("/START"),
      { update_id: 1, edited_message: update().message },
      { update_id: 1, callback_query: { from: { id: 42 }, data: "/start" } },
    ]
  ) equal((await f.handler()(request(body))).status, 200);
  equal(f.entries.size, 0);
  equal(f.users.length + f.replies.length, 0);
});

Deno.test("rejects mismatched identity, groups, bots and malformed IDs", async () => {
  const f = fixture();
  const messages = [
    { ...update().message, chat: { id: 999, type: "private" } },
    { ...update().message, chat: { id: -1, type: "group" } },
    { ...update().message, sender_chat: { id: 42 }, from: undefined },
    ...["42", 0, -42, 1.5, 2 ** 53].map((id) => ({
      ...update().message,
      from: { ...update().message.from, id },
      chat: { id, type: "private" },
    })),
    { ...update().message, from: { ...update().message.from, is_bot: true } },
    { ...update().message, from: { ...update().message.from, first_name: "" } },
  ];
  for (const message of messages) {
    equal(
      (await f.handler()(request({ update_id: 1, user_id: 999, message })))
        .status,
      200,
    );
  }
  equal(f.entries.size, 0);
  equal(f.users.length + f.replies.length, 0);
});

Deno.test("duplicate after a fresh handler does not register or send again", async () => {
  const f = fixture();
  equal((await f.handler()(request(update()))).status, 200);
  equal((await f.handler()(request(update()))).status, 200);
  equal(f.users.length, 1);
  equal(f.replies.length, 1);
  equal((await f.handler()(request(update("/app", 2)))).status, 200);
  equal(f.replies.length, 2);
});

Deno.test("concurrent duplicate waits for the active owner", async () => {
  const f = fixture();
  let unblock!: () => void;
  const waiting = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.store.upsertUser = async () => {
    started();
    await waiting;
  };
  const first = f.handler()(request(update()));
  await ready;
  equal((await f.handler()(request(update()))).status, 503);
  unblock();
  equal((await first).status, 200);
  equal((await f.handler()(request(update()))).status, 200);
  equal(f.replies.length, 1);
});

Deno.test("registration failure releases claim for a safe retry", async () => {
  const f = fixture();
  const upsert = f.store.upsertUser;
  f.store.upsertUser = () => Promise.reject(new Error("database unavailable"));
  equal((await f.handler()(request(update()))).status, 503);
  equal(f.replies.length, 0);
  f.store.upsertUser = upsert;
  equal((await f.handler()(request(update()))).status, 200);
  equal(f.users.length, 1);
  equal(f.replies.length, 1);
});

Deno.test("definitive Telegram rejection can retry", async () => {
  const f = fixture();
  const handler = createHandler(config, f.store, () => {
    throw new TelegramRejected("rate limited");
  }, () => {});
  equal((await handler(request(update("/book")))).status, 503);
  equal(f.entries.size, 0);
  equal((await f.handler()(request(update("/book")))).status, 200);
  equal(f.replies.length, 1);
});

for (const stage of ["send", "complete", "beginSend"] as const) {
  Deno.test(`ambiguous ${stage} failure never automatically resends`, async () => {
    const f = fixture();
    let send = f.sender;
    if (stage === "send") {
      send = () => {
        throw new Error("token-containing URL must stay private");
      };
    } else {
      const original = f.store[stage];
      f.store[stage] = async (id, owner) => {
        await original(id, owner);
        throw new Error("response lost");
      };
    }
    const handler = createHandler(
      config,
      f.store,
      send,
      (event) => f.logs.push(event),
    );
    const response = await handler(request(update()));
    equal(response.status, 503);
    equal(await response.text(), "Webhook processing failed");
    const sent = f.replies.length;
    equal((await f.handler()(request(update()))).status, 200);
    equal(f.replies.length, sent);
    equal(f.logs, ["telegram_webhook_delivery_uncertain"]);
  });
}

Deno.test("missing journal fails closed before registration or sending", async () => {
  const f = fixture();
  f.store.claim = () => Promise.reject(new Error("RPC missing"));
  equal((await f.handler()(request(update()))).status, 503);
  equal(f.users.length + f.replies.length, 0);
});

Deno.test("configuration requires server secrets and HTTPS", async () => {
  const env: Record<string, string> = {
    BOT_TOKEN: config.botToken,
    BOT_USERNAME: config.botUsername,
    TELEGRAM_WEBHOOK_SECRET: config.webhookSecret,
    SUPABASE_URL: config.supabaseUrl,
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: config.adminKey }),
  };
  equal(loadConfig((key) => env[key]), config);
  for (
    const [name, value] of [
      ["BOT_TOKEN", ""],
      ["BOT_USERNAME", ""],
      ["TELEGRAM_WEBHOOK_SECRET", "short"],
      ["SUPABASE_URL", "http://example.test"],
      ["SUPABASE_SECRET_KEYS", "{}"],
      ["WEB_APP_URL", "https://user:password@example.test"],
    ]
  ) {
    await rejects(
      Promise.resolve().then(() =>
        loadConfig((key) => key === name ? value : env[key])
      ),
    );
  }
  const legacy = {
    ...env,
    SUPABASE_SECRET_KEYS: "{}",
    SUPABASE_SERVICE_ROLE_KEY: "legacy-jwt",
  };
  equal(
    loadConfig((key) => legacy[key as keyof typeof legacy]).adminKey,
    "legacy-jwt",
  );
});

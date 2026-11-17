import { deepStrictEqual as equal, rejects } from "node:assert/strict";
import { TelegramRejected } from "./handler.ts";
import { createSender, createStore } from "./services.ts";

const config = {
  botToken: "900:test-token",
  botId: 900,
  botUsername: "BeautyBookingBot",
  webhookSecret: "test-webhook-secret-with-32-characters",
  webAppUrl: "https://example.test",
  supabaseUrl: "https://test.supabase.co",
  adminKey: "sb_secret_test",
};
const reply = {
  chat_id: 42,
  text: "Открыть BB:",
  reply_markup: {
    inline_keyboard: [[{
      text: "Открыть BB",
      web_app: { url: config.webAppUrl },
    }]],
  },
};

Deno.test("REST adapter uses scoped RPCs and insert-only registration", async () => {
  const calls: { path: string; headers: Headers; body: unknown }[] = [];
  const store = createStore(config, (input, init) => {
    const path = String(input).replace(`${config.supabaseUrl}/rest/v1/`, "");
    calls.push({
      path,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    equal(init?.redirect, "error");
    equal(init?.signal instanceof AbortSignal, true);
    return Promise.resolve(
      Response.json(path.endsWith("_claim") ? "acquired" : true),
    );
  });
  equal(await store.claim(12, "owner"), "acquired");
  await store.upsertUser({ user_id: 42, name: "Дарья" });
  await store.beginSend(12, "owner");
  await store.complete(12, "owner");
  await store.release(12, "owner");
  equal(calls.map((call) => call.path), [
    "rpc/telegram_webhook_claim",
    "users?on_conflict=user_id",
    "rpc/telegram_webhook_begin_send",
    "rpc/telegram_webhook_complete",
    "rpc/telegram_webhook_release",
  ]);
  for (const call of calls) {
    equal(call.headers.get("apikey"), config.adminKey);
    equal(call.headers.get("authorization"), null);
    equal(
      call.body,
      call.path.startsWith("users")
        ? { user_id: 42, name: "Дарья" }
        : { p_bot_id: 900, p_update_id: 12, p_owner: "owner" },
    );
  }
  equal(
    calls[1].headers.get("Prefer"),
    "resolution=ignore-duplicates,missing=default,return=minimal",
  );
});

Deno.test("legacy service_role uses bearer; database failures and lost claims throw", async () => {
  const legacy = createStore(
    { ...config, adminKey: "legacy-jwt" },
    (_input, init) => {
      equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer legacy-jwt",
      );
      return Promise.resolve(Response.json("busy"));
    },
  );
  equal(await legacy.claim(1, "owner"), "busy");
  for (
    const response of [
      new Response("private error", { status: 500 }),
      Response.json("unexpected"),
    ]
  ) {
    await rejects(
      createStore(config, () => Promise.resolve(response)).claim(1, "owner"),
    );
  }
  await rejects(
    createStore(config, () => Promise.resolve(Response.json(false))).beginSend(
      1,
      "owner",
    ),
  );
});

Deno.test("Telegram adapter sends plain text and Web App keyboard server to server", async () => {
  await createSender(config, (input, init) => {
    equal(input, `https://api.telegram.org/bot${config.botToken}/sendMessage`);
    equal(init?.method, "POST");
    equal(init?.redirect, "error");
    equal(JSON.parse(String(init?.body)), reply);
    equal(init?.signal instanceof AbortSignal, true);
    return Promise.resolve(
      Response.json({ ok: true, result: { message_id: 123 } }),
    );
  })(reply);
});

Deno.test("Telegram ok:false is a definite rejection; invalid replies are uncertain", async () => {
  await rejects(
    createSender(config, () =>
      Promise.resolve(Response.json({
        ok: false,
        error_code: 429,
        parameters: { retry_after: 10 },
      }, { status: 429 })))(reply),
    TelegramRejected,
  );
  for (
    const response of [
      new Response("Bad gateway", { status: 502 }),
      Response.json({}),
    ]
  ) {
    await rejects(
      createSender(config, () => Promise.resolve(response))(reply),
      (error: unknown) =>
        error instanceof Error && !(error instanceof TelegramRejected),
    );
  }
});

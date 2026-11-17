import { deepStrictEqual as equal, rejects } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { createHandler } from "./handler.ts";
import { createSender, createStore } from "./services.ts";

const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";

Deno.test("migration: durable claims, leases, owner fencing, RLS and full webhook flow", async (t) => {
  const db = new PGlite();
  try {
    // Isolated PostgreSQL fixture: no connections to the Supabase project.
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      create table public.users (user_id bigint primary key, name text not null, phone_number text);
      grant select, insert, update on public.users to service_role;
      insert into public.users values (42, 'Old name', '+79990000000');
    `);
    await db.exec(
      await Deno.readTextFile(
        new URL(
          "../../migrations/20261030181231_telegram_webhook_updates.sql",
          import.meta.url,
        ),
      ),
    );
    const rpc = async (name: string, id: number, token = owner, bot = 900) => {
      const result = await db.query<{ result: string | boolean }>(
        `select public.telegram_webhook_${name}($1, $2, $3) as result`,
        [bot, id, token],
      );
      return result.rows[0].result;
    };
    await db.exec("set role service_role");

    await t.step(
      "persistent duplicate protection and bot isolation",
      async () => {
        equal(await rpc("claim", 1), "acquired");
        equal(await rpc("claim", 1, other), "busy");
        equal(await rpc("begin_send", 1, other), false);
        equal(await rpc("begin_send", 1), true);
        equal(await rpc("claim", 1, other), "duplicate");
        equal(await rpc("complete", 1), true);
        equal(await rpc("release", 1), false);
        equal(await rpc("claim", 1, other), "duplicate");
        equal(await rpc("claim", 1, owner, 901), "acquired");
      },
    );
    await t.step(
      "expired pre-send lease can recover; old owner cannot act",
      async () => {
        equal(await rpc("claim", 2), "acquired");
        await db.exec(`update public.telegram_webhook_updates
        set lease_until = now() - interval '1 minute' where update_id = 2`);
        equal(await rpc("claim", 2, other), "acquired");
        equal(await rpc("begin_send", 2), false);
        equal(await rpc("release", 2), false);
        equal(await rpc("complete", 2), false);
        equal(await rpc("begin_send", 2, other), true);
        await db.exec(`update public.telegram_webhook_updates
        set lease_until = now() - interval '1 minute' where update_id = 2`);
        equal(await rpc("claim", 2), "duplicate");
      },
    );
    await t.step("definite failure can release and acquire again", async () => {
      equal(await rpc("claim", 3), "acquired");
      equal(await rpc("release", 3, other), false);
      equal(await rpc("begin_send", 3), true);
      equal(await rpc("release", 3), true);
      equal(await rpc("claim", 3, other), "acquired");
    });
    await t.step("two requests acquire a single claim", async () => {
      equal(await Promise.all([rpc("claim", 4), rpc("claim", 4, other)]), [
        "acquired",
        "busy",
      ]);
    });
    await t.step("public roles have no journal or RPC access", async () => {
      await db.exec("reset role");
      const result = await db.query<{ relrowsecurity: boolean }>(
        "select relrowsecurity from pg_class where oid = 'public.telegram_webhook_updates'::regclass",
      );
      equal(result.rows[0].relrowsecurity, true);
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`set role ${role}`);
        await rejects(
          db.query("select * from public.telegram_webhook_updates"),
        );
        await rejects(db.exec(`insert into public.telegram_webhook_updates
          (bot_id, update_id, owner) values (900, 5, '${owner}')`));
        for (const name of ["claim", "begin_send", "complete", "release"]) {
          await rejects(rpc(name, 5));
        }
        await db.exec("reset role");
      }
      await db.exec("set role service_role");
    });
    await t.step(
      "handler + REST adapters + PostgreSQL: replay and phone preservation",
      async () => {
        const config = {
          botToken: "900:test-token",
          botId: 900,
          botUsername: "BeautyBookingBot",
          webhookSecret: "test-webhook-secret-with-32-characters",
          webAppUrl: "https://example.test",
          supabaseUrl: "https://test.supabase.co",
          adminKey: "sb_secret_test",
        };
        let sent = 0;
        let registered = 0;
        const rest: typeof fetch = async (input, init) => {
          const url = new URL(String(input));
          const body = JSON.parse(String(init?.body));
          if (url.pathname.endsWith("/users")) {
            registered++;
            equal(
              new Headers(init?.headers).get("Prefer"),
              "resolution=ignore-duplicates,missing=default,return=minimal",
            );
            await db.query(
              `insert into public.users (user_id, name) values ($1, $2)
            on conflict (user_id) do nothing`,
              [body.user_id, body.name],
            );
            return new Response(null, { status: 201 });
          }
          const name = url.pathname.split("/").at(-1)!.replace(
            "telegram_webhook_",
            "",
          );
          return Response.json(
            await rpc(name, body.p_update_id, body.p_owner, body.p_bot_id),
          );
        };
        const telegram: typeof fetch = () => {
          sent++;
          return Promise.resolve(Response.json({ ok: true }));
        };
        const handler = () =>
          createHandler(
            config,
            createStore(config, rest),
            createSender(config, telegram),
          );
        const req = (text: string, id: number) =>
          new Request("https://example.test", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Telegram-Bot-Api-Secret-Token": config.webhookSecret,
            },
            body: JSON.stringify({
              update_id: id,
              message: {
                message_id: id,
                text,
                chat: { id: 42, type: "private" },
                from: { id: 42, is_bot: false, first_name: "Дарья" },
              },
            }),
          });
        for (
          const [id, cmd] of [[10, "/start"], [11, "/app"], [
            12,
            "/book",
          ]] as const
        ) {
          equal((await handler()(req(cmd, id))).status, 200);
          equal((await handler()(req(cmd, id))).status, 200);
        }
        equal(sent, 3);
        equal(registered, 1);
        equal(
          (await db.query(
            "select name, phone_number from public.users where user_id = 42",
          )).rows,
          [{ name: "Old name", phone_number: "+79990000000" }],
        );
      },
    );
  } finally {
    await db.close();
  }
});

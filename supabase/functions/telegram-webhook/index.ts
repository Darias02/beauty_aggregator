import { createHandler, loadConfig } from "./handler.ts";
import { createSender, createStore } from "./services.ts";

try {
  const config = loadConfig((name) => Deno.env.get(name));
  Deno.serve(createHandler(config, createStore(config), createSender(config)));
} catch {
  console.error("telegram_webhook_configuration_invalid");
  Deno.serve(() => new Response("Webhook unavailable", { status: 503 }));
}

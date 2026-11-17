# BB-09 master avatar upload

`POST /functions/v1/master-avatar` accepts multipart fields `init_data` (the exact Telegram WebApp
initData string) and `avatar` (one file). No IDs, paths, URLs, profile patches, duplicate fields or
query parameters are accepted. BB-06 checks the signature and existing 24-hour TTL; only the
verified actor's existing master profile can be changed. The public client key is not an
authorization credential.

JPEG, PNG and WebP require matching byte format, complete structure and successful pixel decoding
without decoder warnings. Limits: 5 MiB of file bytes, 16 KiB of multipart overhead, 4,000,000
pixels, 8192 pixels per side. Animated PNG/WebP are rejected to bound frame count/work. ImageMagick
allows only these input coders (plus the internal 1×1 XC canvas), one thread and 64 MiB of
pixel-cache memory; disk cache, delegates and external paths are disabled. Original validated bytes
are stored without an expensive re-encode. Hosted Edge CPU/memory limits still apply; local timings
are not hosted-runtime guarantees.

The server key is obtained with existing `getAdminKey`. Storage creates a fresh
`<verified-id>/<server-uuid>.<detected-extension>` with `upsert: false`. The DB update filters both
verified identity and the previous avatar URL (compare and swap). The previous object is never
overwritten or deleted. Definitively rejected DB updates clean up only this request's successfully
uploaded object, after a read confirms it is unused. Ambiguous transport/5xx outcomes, uncertain
reads and failed cleanup retain an orphan and log a generic diagnostic. Never blindly delete such
objects: a lost response may hide a committed DB update. Concurrent successful replacements and
uncertain Storage responses can also leave harmless unused objects; automated historical-object
deletion is deliberately excluded.

## Local checks

From this directory, with Deno 2.5.6 or compatible:

```sh
deno task check
deno task test
deno task lint
```

Tests use real WASM decoding and the existing Supabase SDK with local fetch substitutes. They do not
call a live database, Storage or Telegram.

## Packaging for a future deployment

`@imagemagick/magick-wasm@0.0.45` and the unchanged `@supabase/supabase-js@2.118.0` are exact
imports; `deno.lock` pins their integrity and transitive dependencies. `vendor/magick.wasm` is the
package's **x86/wasm32** binary, not its memory64 variant. It is included locally so the function
needs no runtime CDN fetch. Apache license and upstream third-party NOTICE accompany it.

WASM SHA-256: `54629cbcf06dd10db38b4d87fa6ab241b248c09c94f2d9689506e5f994ac5f0c`.

`supabase/config.toml` explicitly includes the binary in this function's `static_files`; `image.ts`
reads that same relative asset via `import.meta.url`. The vendored asset is about 15 MiB. Supabase
documents this packaging method for CLI 2.7.0+ with Docker bundling; the API-only `--use-api` path
does not package static files. Local Deno checks cover loading and executing this exact binary. No
deployment, hosted runtime test, SQL application or live policy change is performed by BB-09. Future
rollout must retain BB-03's client write denials and account for previously issued signed upload
tokens and their expiry.

References:

- https://supabase.com/docs/guides/functions/wasm
- https://supabase.com/docs/guides/functions/examples/image-manipulation

# BB-71 — Deno and avatar checks

Checked on 2026-11-02 from baseline `2ff6b2f7491e01cbff918358d85932314ed3dc12`.
Deno 2.9.8 stable (aarch64-apple-darwin), V8 15.0.245.2-rusty, TypeScript 6.0.3.
Installed with user-approved `brew install deno` (Homebrew 6.0.17).
Only declared public npm dependencies were fetched. No real credentials, cloud project,
Storage, database, Telegram or webhook endpoint was used.

## Function results

All available `deno task check`, `deno task test` and `deno task lint` tasks were run.
Every check includes the real `index.ts`. Final results: 25 tasks passed, 3 lint tasks failed.

| Function | check | test | lint |
| --- | --- | --- | --- |
| booking-create | PASS | 13 PASS (Node task) | No task |
| bookings-read | PASS | 12 PASS | FAIL: 7 diagnostics |
| bookings-write | PASS | 14 PASS | FAIL: 29 diagnostics |
| catalog | PASS | 17 PASS | PASS |
| master-avatar | PASS | 40 PASS | PASS |
| master-profile | PASS | 105 PASS | PASS |
| slots-read | PASS | 12 PASS | PASS |
| slots-write | PASS | 11 PASS | FAIL: 1 diagnostic |
| telegram-webhook | PASS (includes lint/fmt) | 29 PASS, 6 steps | No separate task |
| user-profile | PASS | 118 PASS | PASS |

358 Deno tests and the existing 13 Node booking-create tests passed, with zero failed tests.
The booking-create task explicitly invokes Node; it is not counted as Deno test execution.
Node 24.22.1 was already available in the local ChatGPT app and was used without installation.
notify-master and notify-user have no deno.json tasks and were outside this task matrix.

The confirmed TypeScript error in bookings-read's test harness was fixed by accepting
`string | undefined` in environment overrides. Heterogeneous override fixtures infer absent
keys as undefined; this does not change production logic.

Remaining lint diagnostics are pre-existing and left outside the requested compatibility fixes:

- bookings-read: `require-await` and `no-unused-vars` in `webapp/js/data/bookings.js`.
- bookings-write: the same seven client diagnostics plus 22 `require-await` diagnostics in
  `tests/write.test.ts` (29 total, with overlap across tasks).
- slots-write: `no-control-regex` at `handler.ts:82`, where validation deliberately rejects
  control characters.

## BB-09

The real vendored WASM initializes through `image.ts` and `Deno.readFile`, with no network
permission. A new entrypoint test imports `index.ts`, intercepts only `Deno.serve`, and invokes
the registered OPTIONS handler. The binary's tested SHA-256 is
`54629cbcf06dd10db38b4d87fa6ab241b248c09c94f2d9689506e5f994ac5f0c`.

Real WASM tests decode valid JPEG, PNG and WebP and reject damaged bytes, truncated images,
MIME mismatches, pixel/side limits and animation control chunks (APNG acTL, WebP ANIM/ANMF).
Animation tests use controlled chunk fixtures to exercise the rejection gate, without claiming
to decode complete animated images.

Transport boundaries use controlled byte fixtures and mocked decoding/repositories, separately
from the real WASM tests: exactly 5 MiB succeeds; 5 MiB + 1 fails with 413; multipart beyond
5 MiB + 16 KiB fails with 413. An unending chunk stream without Content-Length is cancelled
as soon as it exceeds the request limit, returns within a two-second test deadline, and never
calls decoding or the repository. A finite chunked multipart containing exactly 5 MiB also
succeeds. An oversized Content-Length returns 413 without reading the body or accessing Storage.

The original oversized multipart test passes under Deno. Under Node 24.22.1 its assertions
complete, then Undici crashes asynchronously with `ERR_INVALID_STATE: ReadableStream is already
closed`. The same error reproduces without any project imports:

```js
const form = new FormData();
form.append('avatar', new File([new Uint8Array(5 * 1024 * 1024 + 20000)], 'photo.png'));
const request = new Request('https://avatar.test', { method: 'POST', body: form });
const reader = request.body.getReader();
while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value.length > 1024) {
        await reader.cancel();
        reader.releaseLock();
        break;
    }
}
await new Promise(resolve => setTimeout(resolve, 100));
```

This isolates the failure to Node's multipart stream producer after cancellation. No handler
workaround was needed; successful Deno execution is the BB-09 verification result.

## Packaging limits

`supabase/config.toml` includes `./functions/master-avatar/vendor/magick.wasm` in `static_files`;
`image.ts` resolves the same existing asset relative to its module URL. The vendored wasm32
binary and accompanying license/NOTICE are present, and dependency versions remain unchanged.
[Supabase's WASM packaging documentation](https://supabase.com/docs/guides/functions/wasm)
requires CLI 2.7.0+ and Docker for static files, excluding the `--use-api` path.

Docker and Supabase CLI are absent and were not installed. Supabase CLI bundle creation,
asset resolution inside that bundle, local Edge Runtime cold start and hosted bundle/cold start
remain unverified. Deno execution does not establish hosted runtime compatibility or resource
budgets. No deploy, SQL changes, PR or merge was performed.

# BB-72 local API checks

These scripts use real Supabase PostgreSQL, Auth, PostgREST, Storage and Edge Runtime.
They do not mock APIs, install software, link projects, deploy, send Telegram messages or set webhooks.
Use only a fresh temporary project. Run Python without `-O`, so safety assertions remain active.

Requirements verified on 2026-11-08: Supabase CLI 3.0.0, Docker CLI 29.9.3,
Colima 0.10.3 with Docker engine 29.5.2, Lima 2.3.0, Python 3.13.
The CLI v3 reset targets local by default and no longer accepts `--local`.

Run from the repository root. Set `BB72_PROJECT` to the absolute path printed by `prepare_local.py`.
Use a different directory for each independent run. These tests reserve ports 57321, 57322 and 57324.

```sh
colima start bb72 --cpu 4 --memory 8 --disk 35 --runtime docker --vm-type vz --activate=false --ssh-config=false --mount /private/tmp:w
docker --context colima-bb72 network create --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 bb72-local-only
python3 tests/bb72/prepare_local.py
export BB72_PROJECT=/private/tmp/bb72-local-supabase-REPLACE_WITH_PRINTED_SUFFIX
export DOCKER_HOST="unix://$HOME/.colima/bb72/docker.sock"
env -u SUPABASE_ACCESS_TOKEN -u SUPABASE_DB_PASSWORD supabase start --workdir "$BB72_PROJECT" --network-id bb72-local-only
python3 tests/bb72/reset_local.py "$BB72_PROJECT"
env -u SUPABASE_ACCESS_TOKEN -u SUPABASE_DB_PASSWORD supabase functions serve --workdir "$BB72_PROJECT" --network-id bb72-local-only --env-file "$BB72_PROJECT/local-functions.env"
```

If the network already exists, inspect its loopback binding instead of recreating it.
Run `python3 tests/bb72/local_probe.py "$BB72_PROJECT"` from a second terminal.
Run the full probe once after the resets. It creates test rows and Storage objects.
Use `--only avatar`, `--only rls` or another listed phase to investigate a failed phase.
Do not rerun the booking phase on its existing fixture rows. Use a guarded reset for a fresh run.

`reset_local.py` checks the temporary path, project_id, container labels, exact loopback port,
local DB URL, migration bytes and absence of `.temp/project-ref` before each reset.
It creates a sentinel, resets twice and checks that each reset removes the sentinel and restores
all repository migrations, three seed services and zero bookings. It passes the same Docker network to reset.

`local_probe.py` checks table and RPC ACL, RLS separately from ACL using rolled-back grants,
Auth-issued client tokens, denied REST/Storage access, a transaction-scoped permissive policy,
missing and forged Telegram initData, nested PostgREST relationships, catalog and booking lifecycles.
BB-73 also checks HTTP 409 / SLOT_HAS_HISTORY on both slot delete/cancel paths
after master/model cancellation, unchanged history after retries and empty-slot deletion.
Two concurrent booking requests must produce one success and one conflict, with one DB row.
Avatar checks use real JPEG, PNG and WebP bytes, direct public URL reads, corrupt bytes,
MIME mismatch, side and pixel limits, file size above 5 MiB and native bucket restrictions.
The first avatar call after a runtime restart exercises cold WASM initialization.

The fake token is hardcoded. Runtime credentials are generated locally and never committed.
`AVATAR_PUBLIC_ORIGIN` changes only the returned public URL; privileged Storage/DB calls keep
the internal gateway URL. The override accepts HTTPS origins or HTTP loopback origins only.
Do not run notification success paths with these scripts. Telegram delivery is outside this test.

Stop `functions serve` with Ctrl-C after testing. Stop only this project and VM:

```sh
supabase stop --workdir "$BB72_PROJECT" --network-id bb72-local-only
colima stop bb72
```

Hosted resource budgets, hosted bundle packaging and Telegram Mini App UI are not verified here.

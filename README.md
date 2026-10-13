# DC UAT Console

Web UI for the manual DuckCreek UAT workflow on the GCP VM:

1. `gcloud compute ssh` → `sudo` → `cd $DC_WORK_DIR` (the directory holding the psql SSL certs)
2. **Create quote** – calls the `wrapper/create-quote` endpoint and shows the `quote_number`
3. **Fetch payloads** – pulls the latest `external_request` / `external_response` from
   the `api_logs` table (`DC_API_LOGS_TABLE`), parses the JSON (including double-encoded JSON) and saves each to `payloads/<policy>_{request,response}_payload.json`

- `backend/` – NestJS API. It keeps a pool of up to `DC_SESSIONS` (default 4) long-lived
  `gcloud compute ssh … 'sudo bash -s'` sessions. Session #1 opens at startup; the others open only when the queue
  needs them, and only after #1 has connected once (so parallel gcloud runs don't race to push the SSH key).
  Policies go through an in-memory FIFO queue with one worker per session. The same policy never runs on two
  sessions at once.
  Each job runs in its own subshell with unique start/end markers. If a job fails, the session stays up. If the session dies,
  it reconnects automatically on the next job. A job that never started is replayed once; a job that may have run is never replayed. If a job hits the
  timeout, the session is killed and restarted.
- `frontend/` – React + Vite UI.

## Setup

```bash
npm install && npm run install:all
cp backend/.env.example backend/.env   # set DC_VM_ZONE (+ DC_SSH_FLAGS=--tunnel-through-iap if needed)
gcloud auth login                      # the header pill turns red when auth has expired
```

## Run

```bash
npm run dev                    # API :3000 + UI http://localhost:5173
# or a single server:
npm run build && npm start     # http://localhost:3000
```

## Config (`backend/.env`)

| Var | Purpose |
| --- | --- |
| `DC_VM_NAME` / `DC_VM_ZONE` / `DC_VM_PROJECT` | Target VM (default `instance-1`) |
| `DC_SSH_FLAGS` | Extra `gcloud compute ssh` flags |
| `DC_PG_PASSWORD` | Optional; when empty, the UI asks for the password |
| `DC_OUT_DIR` | Where payload files are saved (default `./payloads`) |
| `DC_SESSIONS` | Parallel SSH sessions / workers (default 4, max 8) |
| `DC_TIMEOUT_SECONDS` | Per-job timeout (default 180); when it's hit, the session is restarted |
| `DC_CONNECT_TIMEOUT_SECONDS` | Time allowed to open the SSH session (default 90) |
| `DC_WORK_DIR`, `DC_CREATE_QUOTE_URL`, `DC_PG_CONN`, `DC_API_LOGS_TABLE` | **Required.** VM directory, wrapper URL, psql connection string, api_logs table (see `.env.example`) |
| `DC_LOCAL=true` | Server is running on the VM itself, so SSH is skipped |

## Batches

Each submission is a **batch**. Its default name is the date and time; you can rename it in the UI. Every batch has a
report: succeeded and failed counts, each policy's result, and a CSV download. Each failure is classified:

| Kind | Meaning | Retry? |
| --- | --- | --- |
| `connection` | Our side: SSH/IAP drop, timeout, curl couldn't connect, Postgres unreachable | Yes, retry is suggested |
| `server` | create-quote gateway/service error (5xx, non-JSON) | Yes, but it may already have created a quote |
| `api` | The API rejected the policy, or there's no `api_logs` row | No, fix the data first |
| `input` | Wrong Postgres password, etc. | After fixing the input |

A retry stays in the same batch, and each policy keeps a history of its attempts. If a **Both** job already created its
quote and only the payload step failed, the retry only re-fetches the payloads (no second quote). Batches persist in
`data/batches.json` (`DC_DATA_DIR`). Jobs that were running when the server stopped come back as retryable
`connection` failures.

## API

- `GET /api/status` – gcloud auth state, VM config
- `GET /api/state?since=<seq>&batch=<id>` – sessions, batch summaries, the selected batch's jobs, and new log events (the UI polls this)
- `POST /api/batches` `{ policies, action: "quote" | "payloads" | "all", name?, pgPassword? }` – start a batch
- `GET /api/batches/:id`, `PATCH /api/batches/:id` `{ name }`, `DELETE /api/batches/:id`
- `POST /api/batches/:id/retry` `{ jobIds?, pgPassword? }` – without `jobIds`, retries every connection/server failure
- `POST /api/batches/:id/cancel` – cancel the batch's queued policies
- `POST /api/session/reconnect` – retry SSH sessions that failed
- `GET /api/files/:name` – a saved payload file

The server listens on `127.0.0.1` only, because it runs commands as root on the UAT VM. The script is sent over SSH stdin, so the DB password never appears in process args.

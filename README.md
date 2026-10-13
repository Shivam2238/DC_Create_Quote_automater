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
| `DC_LOCAL=true` | Server is running on the VM itself, so SSH is skipped |

## API

- `GET /api/status` – gcloud auth state, VM config
- `POST /api/jobs` `{ policies: string[], action: "quote" | "payloads" | "all", pgPassword? }` – adds the policies to the queue
- `GET /api/jobs` – session state, pending count and all jobs with their results (the UI polls this)
- `POST /api/jobs/cancel` – drop queued jobs · `DELETE /api/jobs` – clear finished jobs
- `POST /api/session/reconnect` – restart the SSH session
- `GET /api/files`, `GET /api/files/:name` – list and download saved payloads

The server listens on `127.0.0.1` only, because it runs commands as root on the UAT VM. The script is sent over SSH stdin, so the DB password never appears in process args.

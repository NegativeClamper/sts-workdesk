# STS OrderDesk (Powered by Google Gemini)

PO → production checklist tool with AI-assisted order extraction, built for
commercial-grade data quality: structured output, deterministic arithmetic
cross-checks, an automatic correction pass, and a mandatory human review gate.

## How accuracy is enforced (v2)

Getting values "exactly right" from mixed handwritten/printed POs is done with
four layers — only the first one is AI:

1. **Structured output** — Gemini is forced to answer against a JSON schema
   (`response_schema` + `temperature=0`). No markdown fences, no missing
   fields, deterministic decoding.
2. **Copy, don't compute** — the model is told to *copy* the line amounts and
   the totals printed on the document, never to calculate them. The server
   then recomputes everything independently:
   - `qty × rate = amount` per line (0.5 % tolerance)
   - `Σ line amounts = stated basic value`
   - `Σ qty = stated total qty`
   - `basic + tax = grand total`
   When the document's own numbers and the recomputed numbers agree, the read
   was almost certainly correct — two independent paths reached the same figures.
3. **Automatic correction pass** — if any check fails, the document goes back
   to Gemini once with the exact mismatch list ("Line 4: 40×5856=234240 but
   printed amount is 251808") and it re-reads only the doubtful figures.
   Bounded to one retry, so cost stays at most 2 calls per document.
4. **Human review gate** — every AI-read order opens in a review modal showing
   the check results and per-line confidence (`high/medium/low`). Handwritten
   digits the model found ambiguous (1/7, 4/9, 0/6…) are flagged with the
   alternative reading. Nothing enters the checklist until a person clicks
   **Add to checklist**.

### Taxes
GST is extracted per document (IGST vs CGST+SGST, rate, amount) and per line
when rates differ. Every checklist line has an editable GST % column; the
manifest and Excel export show Basic / GST / Grand total.

### Weights
Unit weights come from the STS catalogue tables (gate, air, check valves by
DN). If a line has no catalogue weight (unknown DN or product), it is
highlighted amber, counted in the manifest warning ("estimate is LOW"), and
accepts a typed-in weight — so the dispatch estimate is never silently short.
The DN parser also reads sizes out of descriptions ("100MM", "DN100", "4 inch")
when the extractor left DN empty.

## Architecture

```
Browser (static/index.html + app.js)
   │  POST /api/extract  {text?, files:[{media_type, base64 data}]}
   ▼
FastAPI proxy (main.py) — holds GEMINI_API_KEY, builds prompt, forces schema
   │  1st call: extract        2nd call (only on mismatch): correct
   ▼
Google Gemini (gemini-2.5-flash, temperature 0, JSON schema)
   ▲
   └─ server verifies arithmetic → {order, verification, meta} → review modal
```

## Run locally

```bash
python3 -m venv venv && source venv/bin/activate   # Windows: .\venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env      # Windows: copy .env.example .env — then paste your key
uvicorn main:app --reload
# open http://localhost:8000
```

## Deploy

- **Render / Railway / Fly.io**: connect the repo, set `GEMINI_API_KEY` in the
  dashboard, deploy.
- **Docker**: `docker build -t sts-orderdesk . && docker run -p 8000:8000 --env-file .env sts-orderdesk`
- **VPS**: `uvicorn main:app --host 0.0.0.0 --port 8000` behind Nginx/Caddy + HTTPS.

Set `APP_SHARED_SECRET` in `.env` when exposing publicly — the UI will prompt
for it once and send it as `X-App-Key`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | required |
| `GEMINI_MODEL` | `gemini-2.5-flash` | switch to `gemini-2.5-pro` for very hard handwriting |
| `APP_SHARED_SECRET` | unset | optional access gate |
| `MAX_FILE_MB` | 20 | upload size limit |
| `ENABLE_CORRECTION_PASS` | 1 | set 0 to disable the 2nd AI call |

## Cost

Normal document: 1 Gemini call. Document that fails arithmetic checks: 2 calls.
`/api/health` returns model + prompt version for monitoring.

## Practical tips for best scans

- Photograph POs flat, in good light, with the full table in frame.
- Prefer PDF over photo when the customer can send one.
- For handwritten orders on gemini-2.5-flash, watch the review modal's flagged
  lines; if a customer's handwriting consistently misreads, set
  `GEMINI_MODEL=gemini-2.5-pro` — costlier but stronger vision.

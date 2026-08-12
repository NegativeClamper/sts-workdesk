"""STS OrderDesk backend — PO extraction proxy for Google Gemini.

Accuracy-focused design for commercial use:

1.  STRUCTURED OUTPUT   Gemini is forced to answer with a JSON schema
    (response_schema), so malformed JSON / markdown fences cannot occur.
2.  TEMPERATURE 0       Deterministic decoding for data entry.
3.  SELF-TRANSCRIBED TOTALS
    The model must also copy the totals PRINTED ON THE DOCUMENT
    (basic value, tax, grand total, total qty). The server then recomputes
    everything from the extracted lines and compares. Numbers agreeing from
    two independent directions is the strongest signal the read is correct.
4.  DETERMINISTIC VERIFICATION (server-side, no AI):
      - qty x rate == amount per line (0.5 % tolerance)
      - sum of line amounts == stated basic total
      - sum of qty == stated total qty
      - grand total == basic + tax
5.  AUTOMATIC CORRECTION PASS
    If reconciliation fails, the document is sent back to Gemini once,
    together with the first JSON and the exact list of mismatches, and it
    is asked to re-read ONLY the doubtful figures. (One retry, bounded cost.)
6.  PER-LINE CONFIDENCE  The model marks each line high/medium/low —
    low lines are highlighted in the UI for human review before they
    enter the checklist. Humans stay in the loop for commercial data.
"""

import base64
import binascii
import json
import os
import time
from typing import Any, Dict, List, Literal, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

load_dotenv(override=True)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
APP_SHARED_SECRET = os.environ.get("APP_SHARED_SECRET")  # optional gate
MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
MAX_FILE_MB = float(os.environ.get("MAX_FILE_MB", "20"))
ENABLE_CORRECTION_PASS = os.environ.get("ENABLE_CORRECTION_PASS", "1") != "0"

if not GEMINI_API_KEY:
    raise RuntimeError(
        "GEMINI_API_KEY is not set. Copy .env.example to .env and fill it in "
        "with a key from Google AI Studio (https://aistudio.google.com/app/apikey)."
    )

client = genai.Client(api_key=GEMINI_API_KEY)
app = FastAPI(title="STS OrderDesk")

# --------------------------------------------------------------------------
# Extraction schema (also used as Gemini response_schema)
# --------------------------------------------------------------------------

class LineItem(BaseModel):
    sno: Optional[int] = Field(None, description="Serial number as printed, if any")
    description: str = Field(..., description="Item description exactly as written")
    dn: Optional[float] = Field(None, description="Nominal diameter in mm (DN)")
    pn: Optional[float] = Field(None, description="Pressure rating (PN), e.g. 16")
    qty: float = Field(..., description="Quantity as a plain number")
    rate: Optional[float] = Field(None, description="Unit price as a plain number")
    amount: Optional[float] = Field(
        None, description="Line amount AS PRINTED on the document, if printed"
    )
    gst_percent: Optional[float] = Field(
        None, description="GST rate for this line if stated, e.g. 18"
    )
    delivery: Optional[str] = Field(None, description="Delivery date/terms for the line")
    confidence: Literal["high", "medium", "low"] = Field(
        ..., description="low if any digit was hard to read (handwriting, blur)"
    )
    note: Optional[str] = Field(
        None, description="What was uncertain, e.g. 'qty could be 40 or 46'"
    )


class TaxInfo(BaseModel):
    # No default values — Gemini response_schema rejects fields with defaults.
    kind: Literal["igst", "cgst_sgst", "none", "unknown"]
    rate_percent: Optional[float] = Field(None, description="Overall GST rate, e.g. 18")
    amount: Optional[float] = Field(None, description="Total tax amount as printed")


class AdditionalCharge(BaseModel):
    """Any charge beyond line-item totals: supply, freight, P&F, insurance, etc."""
    description: str = Field(..., description="e.g. 'Supply charges', 'Freight', 'Packing & Forwarding'")
    amount: float = Field(..., description="Charge amount as printed")
    tax_percent: Optional[float] = Field(None, description="Tax rate on this charge, if any, e.g. 18")
    tax_amount: Optional[float] = Field(None, description="Tax amount on this charge, as printed")


class StatedTotals(BaseModel):
    """Totals COPIED from the document itself — not computed."""
    total_qty: Optional[float] = Field(None, description="Total quantity as printed")
    basic_value: Optional[float] = Field(None, description="Total before tax, as printed")
    tax_amount: Optional[float] = Field(None, description="Total tax amount as printed")
    grand_total: Optional[float] = Field(None, description="Final payable, as printed")
    rounding_off: Optional[float] = Field(None, description="Rounding adjustment as printed, e.g. 0.04 or -0.50")


class ExtractedOrder(BaseModel):
    document_type: Literal["purchase_order", "quotation", "invoice", "other"]
    quality: Literal["printed", "handwritten", "mixed", "poor_scan"]
    customer: Optional[str] = Field(None, description="Buyer company name")
    po_ref: Optional[str] = Field(None, description="PO reference number")
    po_date: Optional[str] = Field(None, description="Date as written")
    terms: Optional[str] = Field(None, description="Delivery and payment terms")
    tax: TaxInfo
    stated_totals: StatedTotals
    additional_charges: List[AdditionalCharge]
    items: List[LineItem]


PROMPT_VERSION = "2026-07-25.2"

EXTRACT_PROMPT = f"""You are the order-entry engine (prompt {PROMPT_VERSION}) for STS Valves India Pvt Ltd,
Hyderabad — a manufacturer of DI resilient-seated gate (sluice) valves, air valves
(single/double chamber, kinetic, triple-function) and non-return / check valves
(swing, tilting-disc, dual-plate).

TASK: read the purchase order (printed table, scan, photo, or handwritten note)
and extract every line item plus the document's own totals, following the JSON
schema you were given. Accuracy matters more than speed — the output feeds a
commercial production and invoicing system.

READING RULES
1. Numbers, Indian format: 64,77,159.00 means 6477159.00. Never drop or add digits.
2. Sizes: "100MM Dia.", "DN100", "100 NB" all mean dn=100. Inches: 4" or 4 inch
   means dn = 4 x 25 = 100 (2"=50, 2.5"=65, 3"=80, 6"=150, 8"=200, 10"=250, 12"=300).
3. PN: "PN16", "PN 1.6 MPa", "Rating 16" mean pn=16. If unstated, leave null.
4. HANDWRITING: read digit by digit. Confusable pairs: 1/7, 4/9, 0/6, 5/S, 2/Z.
   If a figure is genuinely ambiguous, choose the best reading, set
   confidence="low" and write the alternative in note (e.g. "qty could be 40 or 46").
   Never silently guess a clean-looking number for a messy one.
5. amount = copy the printed line amount if the document shows one. Do NOT
   compute it yourself; the server cross-checks qty x rate against it.
6. stated_totals = copy the totals PRINTED on the document (total qty, basic
   value, tax, grand total). Copy, never calculate. Null if not printed.
7. Tax: identify GST structure. CGST+SGST 9%+9% means kind=cgst_sgst,
   rate_percent=18. IGST 18% means kind=igst, rate_percent=18. Per-line rates,
   if different across lines, go in each line's gst_percent.
8. Include EVERY line item, including repeated products with different
   quantities — never merge or dedupe lines.
9. If the document is not an order/quotation/invoice, return document_type
   ="other" with an empty items list.
10. description: transcribe as written (expand only obvious abbreviations like
    "D/F" = double flanged). Keep bracketed remarks such as "(8 holes)".
11. ADDITIONAL CHARGES: POs often have charges BEYOND the line-item total —
    supply charges, freight, packing & forwarding, insurance, etc. These appear
    after the line-items total and before the grand total. Extract each one into
    additional_charges with its description, amount, and any tax applied to it
    (tax_percent, tax_amount). Common pattern: "Supply charges 5,00,000" with
    "IGST @18% on supply charges 90,000".
12. ROUNDING OFF: if the document shows a rounding adjustment (e.g. "Round off
    0.04" or "-0.50"), record it in stated_totals.rounding_off. Copy the sign
    exactly as printed.
"""

CORRECTION_PROMPT = """You previously extracted the JSON below from this same document,
but the server's arithmetic cross-checks found the listed mismatches.
Re-read the document carefully — especially the figures named in the mismatches —
and return the FULL corrected JSON in the same schema. If the document itself
contains an arithmetic error (that happens on real POs), keep the figures exactly
as printed and do not "fix" them; the mismatch will then be reported to the human.

PREVIOUS EXTRACTION:
{previous}

MISMATCHES FOUND:
{problems}
"""

# --------------------------------------------------------------------------
# Request / response models
# --------------------------------------------------------------------------

class FilePart(BaseModel):
    media_type: str
    data: str  # base64


class ExtractRequest(BaseModel):
    text: Optional[str] = None
    files: List[FilePart] = []


# --------------------------------------------------------------------------
# Deterministic verification (pure Python, no AI)
# --------------------------------------------------------------------------

REL_TOL = 0.005  # 0.5 %
ABS_TOL = 1.0    # one rupee


def _close(a: Optional[float], b: Optional[float]) -> Optional[bool]:
    if a is None or b is None:
        return None
    return abs(a - b) <= max(ABS_TOL, REL_TOL * max(abs(a), abs(b)))


def verify(order: ExtractedOrder) -> Dict[str, Any]:
    checks: List[Dict[str, Any]] = []
    problems: List[str] = []

    computed_basic = 0.0
    basic_complete = True
    computed_qty = 0.0

    for i, it in enumerate(order.items, 1):
        computed_qty += it.qty or 0
        if it.rate is not None:
            line_calc = round((it.qty or 0) * it.rate, 2)
            computed_basic += line_calc
            if it.amount is not None and _close(line_calc, it.amount) is False:
                msg = (f"Line {i} ({it.description[:40]}…): qty {it.qty} x rate "
                       f"{it.rate} = {line_calc}, but printed amount is {it.amount}")
                checks.append({"level": "warn", "check": f"line {i} amount", "detail": msg})
                problems.append(msg)
        else:
            basic_complete = False

    st = order.stated_totals

    def add(name: str, stated: Optional[float], computed: Optional[float]) -> None:
        ok = _close(stated, computed)
        if ok is None:
            checks.append({"level": "info", "check": name,
                           "detail": "not printed on document — nothing to compare"})
        elif ok:
            checks.append({"level": "ok", "check": name,
                           "detail": f"document {stated} = computed {round(computed,2)}"})
        else:
            msg = f"{name}: document says {stated}, computed {round(computed,2)}"
            checks.append({"level": "warn", "check": name, "detail": msg})
            problems.append(msg)

    add("total quantity", st.total_qty, computed_qty)
    if basic_complete:
        add("basic value", st.basic_value, computed_basic)

    # --- Grand total: basic + tax-on-basic + additional charges (with their taxes) + rounding ---
    if st.grand_total is not None:
        computed_grand = None
        # Sum additional charges and their taxes
        extra = 0.0
        for ac in order.additional_charges:
            extra += ac.amount or 0
            extra += ac.tax_amount or 0
        rounding = st.rounding_off or 0

        if st.basic_value is not None and st.tax_amount is not None:
            computed_grand = st.basic_value + st.tax_amount + extra + rounding
        elif st.basic_value is not None and order.tax.rate_percent is not None:
            tax_on_basic = st.basic_value * (order.tax.rate_percent / 100.0)
            computed_grand = st.basic_value + tax_on_basic + extra + rounding

        if computed_grand is not None:
            add("grand total", st.grand_total, round(computed_grand, 2))

    low_conf = [i for i, it in enumerate(order.items, 1) if it.confidence == "low"]
    reconciled = not problems
    return {
        "reconciled": reconciled,
        "checks": checks,
        "problems": problems,
        "low_confidence_lines": low_conf,
        "computed": {"total_qty": computed_qty,
                     "basic_value": round(computed_basic, 2) if basic_complete else None},
    }


# --------------------------------------------------------------------------
# Gemini plumbing
# --------------------------------------------------------------------------

def _gen_config() -> types.GenerateContentConfig:
    return types.GenerateContentConfig(
        temperature=0,
        max_output_tokens=16384,
        response_mime_type="application/json",
        response_schema=ExtractedOrder,
    )


def _call_gemini(parts: List[types.Part]) -> ExtractedOrder:
    last_err: Optional[Exception] = None
    for attempt in range(3):
        try:
            resp = client.models.generate_content(
                model=MODEL, contents=parts, config=_gen_config()
            )
            if getattr(resp, "parsed", None) is not None:
                return resp.parsed  # already an ExtractedOrder
            return ExtractedOrder.model_validate(json.loads(resp.text))
        except Exception as e:  # transient errors / rare schema hiccup
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise HTTPException(status_code=502, detail=f"Gemini API error: {last_err}")


def _build_parts(req: ExtractRequest, extra_text: str = "") -> List[types.Part]:
    parts: List[types.Part] = [types.Part.from_text(text=EXTRACT_PROMPT + extra_text)]
    for f in req.files:
        try:
            raw = base64.b64decode(f.data, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=400, detail="Invalid base64 in uploaded file")
        if len(raw) > MAX_FILE_MB * 1024 * 1024:
            raise HTTPException(status_code=413,
                                detail=f"File larger than {MAX_FILE_MB} MB limit")
        parts.append(types.Part.from_bytes(data=raw, mime_type=f.media_type))
    if req.text:
        parts.append(types.Part.from_text(
            text="--- PURCHASE ORDER TEXT ---\n" + req.text))
    return parts


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    return {"ok": True, "model": MODEL, "prompt_version": PROMPT_VERSION}


@app.post("/api/extract")
async def extract(req: ExtractRequest,
                  x_app_key: Optional[str] = Header(default=None)):
    if APP_SHARED_SECRET and x_app_key != APP_SHARED_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")
    if not req.text and not req.files:
        raise HTTPException(status_code=400, detail="Send text and/or files")

    order = _call_gemini(_build_parts(req))
    report = verify(order)
    passes = 1

    # One bounded correction pass when arithmetic does not reconcile.
    if ENABLE_CORRECTION_PASS and not report["reconciled"] and order.items:
        correction = CORRECTION_PROMPT.format(
            previous=order.model_dump_json(indent=1),
            problems="\n".join(f"- {p}" for p in report["problems"]),
        )
        order2 = _call_gemini(_build_parts(req, extra_text="\n\n" + correction))
        report2 = verify(order2)
        passes = 2
        # keep whichever extraction reconciles better
        if len(report2["problems"]) < len(report["problems"]):
            order, report = order2, report2

    return {"order": order.model_dump(), "verification": report,
            "meta": {"model": MODEL, "prompt_version": PROMPT_VERSION,
                     "passes": passes}}


# Serve the frontend at "/" — mounted last so /api/* matches first.
app.mount("/", StaticFiles(directory="static", html=True), name="static")

import eventlet
eventlet.monkey_patch()

import os
import uuid
import time
import json
import threading

from flask import Flask, request, jsonify, send_from_directory, make_response
from flask_cors import CORS
from flask_socketio import SocketIO, emit
from dotenv import load_dotenv

import fitz  # PyMuPDF
from pdf_processor import PDFProcessor
from vocal_bridge import VocalBridgeClient
from agents import Librarian, Navigator, QuizMaster

import jwt as pyjwt
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

_firestore = None
_db = None
_db_lock = threading.Lock()

def _get_db():
    """Lazy-init Firestore client — deferred so cold-start is not slowed by grpcio import."""
    global _firestore, _db
    if _db is not None:
        return _db
    with _db_lock:
        if _db is not None:
            return _db
        try:
            from google.cloud import firestore as fs
            _firestore = fs
            _db = fs.Client(project=os.environ.get('GCP_PROJECT_ID', 'learnaloud-app'))
        except Exception as e:
            print(f"[Firestore] Not available: {e}")
    return _db


# ── GCS (lazy-init) ───────────────────────────────────────────────────────────
_gcs_bucket = None
_gcs_lock = threading.Lock()
GCS_BUCKET = os.environ.get('GCS_BUCKET', 'learnaloud-sessions')


def _get_gcs_bucket():
    """Lazy-init GCS bucket handle."""
    global _gcs_bucket
    if _gcs_bucket is not None:
        return _gcs_bucket
    with _gcs_lock:
        if _gcs_bucket is not None:
            return _gcs_bucket
        try:
            from google.cloud import storage
            client = storage.Client(project=os.environ.get('GCP_PROJECT_ID', 'learnaloud-app'))
            _gcs_bucket = client.bucket(GCS_BUCKET)
        except Exception as e:
            print(f"[GCS] Not available: {e}")
    return _gcs_bucket

load_dotenv()

# Determine if running in production
FLASK_ENV = os.environ.get('FLASK_ENV', 'development')
IS_PRODUCTION = FLASK_ENV == 'production'

app = Flask(__name__)
app.config["SECRET_KEY"] = "learnaloud-secret"

# Production CORS (wider permissions in dev, restricted in prod)
if IS_PRODUCTION:
    CORS(app, resources={r"/api/*": {"origins": os.environ.get('ALLOWED_ORIGINS', '*')}, r"/socket.io/*": {"origins": os.environ.get('ALLOWED_ORIGINS', '*')}})
else:
    CORS(app, resources={r"/api/*": {"origins": "*"}, r"/socket.io/*": {"origins": "*"}})
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Session persistence storage
SESSIONS_DIR = os.path.join(os.path.dirname(__file__), "session_data")
os.makedirs(SESSIONS_DIR, exist_ok=True)
SESSIONS_INDEX_FILE = os.path.join(SESSIONS_DIR, "sessions_index.json")
USERS_FILE = os.path.join(SESSIONS_DIR, "users.json")

GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '')
JWT_SECRET = os.environ.get('JWT_SECRET', 'learnaloud-jwt-secret-change-in-prod')
JWT_EXPIRY_HOURS = 24


def _fs_log_event(event_type: str, data: dict):
    """Write an event to Firestore in a native thread (avoids eventlet/gRPC conflict)."""
    def _write():
        db = _get_db()
        if not db:
            return
        try:
            data['type'] = event_type
            data['timestamp'] = _firestore.SERVER_TIMESTAMP
            db.collection('events').add(data)
        except Exception as e:
            print(f"[Firestore] event write failed: {e}")
    threading.Thread(target=_write, daemon=True).start()


def _require_auth():
    """Validate Bearer JWT from Authorization header. Returns payload dict or None."""
    auth = request.headers.get('Authorization', '')
    if not auth.startswith('Bearer '):
        return None
    try:
        return pyjwt.decode(auth[7:], JWT_SECRET, algorithms=['HS256'])
    except Exception:
        return None


def _load_sessions_index():
    """Load the sessions index — Firestore primary (via tpool), disk fallback."""
    import eventlet.tpool
    db = _get_db()
    if db:
        try:
            def _fetch():
                docs = db.collection('uploads').stream()
                return [doc.to_dict() for doc in docs]
            return {"sessions": eventlet.tpool.execute(_fetch)}
        except Exception as e:
            print(f"[Firestore] load_sessions_index: {e}")
    # disk fallback
    if os.path.exists(SESSIONS_INDEX_FILE):
        try:
            with open(SESSIONS_INDEX_FILE, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return {"sessions": []}


def _upsert_index_entry(entry):
    """Persist one sessions-index entry to Firestore (async) + disk fallback."""
    db = _get_db()
    if db:
        def _write():
            try:
                db.collection('uploads').document(entry['id']).set(entry)
            except Exception as e:
                print(f"[Firestore] upsert_index_entry: {e}")
        threading.Thread(target=_write, daemon=True).start()
    # disk fallback
    try:
        index = {"sessions": []}
        if os.path.exists(SESSIONS_INDEX_FILE):
            with open(SESSIONS_INDEX_FILE, "r") as f:
                index = json.load(f)
        if not any(e.get("id") == entry["id"] for e in index["sessions"]):
            index["sessions"].append(entry)
            with open(SESSIONS_INDEX_FILE, "w") as f:
                json.dump(index, f, indent=2)
    except Exception:
        pass


def _save_sessions_index(index):
    """Legacy full-index save — upserts every entry to Firestore + disk."""
    for entry in index.get("sessions", []):
        if entry.get("id"):
            _upsert_index_entry(entry)
    try:
        with open(SESSIONS_INDEX_FILE, "w") as f:
            json.dump(index, f, indent=2)
    except Exception:
        pass


def _get_session_file(session_id):
    """Get the file path for a session's data."""
    return os.path.join(SESSIONS_DIR, f"{session_id}.json")


def _load_session_record(session_id):
    """Load a session record — Firestore primary (via tpool), disk fallback."""
    import eventlet.tpool
    db = _get_db()
    if db:
        try:
            def _fetch():
                doc = db.collection('learning_sessions').document(session_id).get()
                return doc.to_dict() if doc.exists else None
            result = eventlet.tpool.execute(_fetch)
            if result is not None:
                return result
        except Exception as e:
            print(f"[Firestore] load_session_record {session_id}: {e}")
    # disk fallback
    filepath = _get_session_file(session_id)
    if os.path.exists(filepath):
        try:
            with open(filepath, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return None


def _save_session_record(session_id, record):
    """Save a session record to Firestore (async) + local disk fallback."""
    db = _get_db()
    if db:
        def _write():
            try:
                db.collection('learning_sessions').document(session_id).set(record)
            except Exception as e:
                print(f"[Firestore] save_session_record {session_id}: {e}")
        threading.Thread(target=_write, daemon=True).start()
    # disk fallback (best-effort)
    try:
        filepath = _get_session_file(session_id)
        with open(filepath, "w") as f:
            json.dump(record, f, indent=2)
    except Exception:
        pass


# ── GCS session helpers ───────────────────────────────────────────────────────

def _gcs_save_session(session_id, session_dict, local_pdf_path):
    """Upload PDF file + parsed data blob to GCS. Runs in a background thread."""
    bucket = _get_gcs_bucket()
    if not bucket:
        return

    def _upload():
        try:
            # PDF file
            pdf_blob = bucket.blob(f"pdfs/{session_id}.pdf")
            pdf_blob.upload_from_filename(local_pdf_path)
            # Parsed data (pdf_data + outline + metadata) as JSON
            data_blob = bucket.blob(f"data/{session_id}.json")
            payload = json.dumps({
                "pdf_data": session_dict["pdf_data"],
                "outline":  session_dict["outline"],
                "filename": session_dict["filename"],
                "title":    session_dict.get("title", ""),
            })
            data_blob.upload_from_string(payload, content_type="application/json")
            print(f"[GCS] session {session_id} saved ({len(payload)//1024} KB data)")
        except Exception as e:
            print(f"[GCS] save_session {session_id} failed: {e}")

    threading.Thread(target=_upload, daemon=True).start()


def _gcs_restore_session(session_id):
    """Load session from GCS into the in-memory cache (via tpool). Returns dict or None."""
    import eventlet.tpool
    bucket = _get_gcs_bucket()
    if not bucket:
        return None
    try:
        def _fetch():
            blob = bucket.blob(f"data/{session_id}.json")
            if not blob.exists():
                return None
            return json.loads(blob.download_as_text())
        content = eventlet.tpool.execute(_fetch)
        if not content:
            return None
        session = {
            "filepath": os.path.join(UPLOAD_DIR, f"{session_id}.pdf"),
            "pdf_data": content["pdf_data"],
            "outline":  content["outline"],
            "filename": content["filename"],
            "title":    content.get("title", ""),
            "current_page": 1,
            "transcript_summary": "",
            "concepts_discussed": [],
        }
        sessions[session_id] = session
        print(f"[GCS] restored session {session_id}")
        return session
    except Exception as e:
        print(f"[GCS] restore_session {session_id} failed: {e}")
        return None


def _get_session(session_id):
    """Return session dict from memory cache, or restore from GCS on miss."""
    return sessions.get(session_id) or _gcs_restore_session(session_id)

pdf_processor = PDFProcessor()
vocal_bridge = VocalBridgeClient(os.getenv("VOCAL_BRIDGE_API_KEY", ""))
vocal_bridge_author = VocalBridgeClient(os.getenv("VOCAL_BRIDGE_AUTHOR_API_KEY", ""))
vocal_bridge_reviewer = VocalBridgeClient(os.getenv("VOCAL_BRIDGE_REVIEWER_API_KEY", ""))
librarian = Librarian(UPLOAD_DIR, pdf_processor)
navigator = Navigator()
quiz_master = QuizMaster()

# In-memory session store: session_id -> {filepath, pdf_data, filename, outline}
sessions = {}



def _build_pdf_context(pdf_data, filename, outline):
    """Build the full PDF context string for the voice tutor."""
    outline_lines = []
    if outline.get("abstract"):
        outline_lines.append(f"ABSTRACT: {outline['abstract']}")
        outline_lines.append("")
    if outline.get("sections"):
        outline_lines.append("PAPER STRUCTURE:")
        for s in outline["sections"]:
            indent = "  " if s["level"] == 2 else ""
            outline_lines.append(f"{indent}- {s['heading']} (page {s['page']})")
        outline_lines.append("")
    if outline.get("figures"):
        outline_lines.append("FIGURES:")
        for f in outline["figures"]:
            outline_lines.append(f"- {f['label']} (page {f['page']}, bbox=({f['bbox'][0]:.0f},{f['bbox'][1]:.0f},{f['bbox'][2]:.0f},{f['bbox'][3]:.0f}))")
        outline_lines.append("")
    if outline.get("key_terms"):
        outline_lines.append(f"KEY TERMS: {', '.join(outline['key_terms'])}")
        outline_lines.append("")

    total_pages = pdf_data.get("total_pages", len(pdf_data.get("pages", [])))
    lines = [
        f'PDF: "{filename}" — {total_pages} pages.',
        "",
        "=== PAPER OUTLINE (preprocessed) ===",
        *outline_lines,
        "=== END OUTLINE ===",
        "",
        "=== FULL PDF TEXT (every page, every word) ===",
    ]
    # Budget: 50 000 bytes for page text (leaves room for outline + instructions + JSON wrapper)
    MAX_PAGE_BYTES = 50_000
    page_bytes_used = 0
    pages_included = 0
    all_pages = pdf_data.get("pages", [])
    for page in all_pages:
        page_line = f"--- Page {page['page_num']} ---"
        text_line = " ".join(b["text"] for b in page["blocks"])
        fig_lines = []
        for fig in page.get("figures", []):
            bbox = fig["bbox"]
            fig_lines.append(
                f'[FIGURE on page {page["page_num"]}: "{fig["label"]}" '
                f"bbox=({bbox[0]:.0f},{bbox[1]:.0f},{bbox[2]:.0f},{bbox[3]:.0f}) "
                f"pageSize=({page['width']:.0f},{page['height']:.0f})]"
            )
        page_block = "\n".join([page_line, text_line] + fig_lines + [""])
        block_bytes = len(page_block.encode("utf-8"))
        if page_bytes_used + block_bytes > MAX_PAGE_BYTES:
            lines.append(f"[Pages {page['page_num']}–{total_pages} omitted — exceeds context limit]")
            break
        lines.append(page_block)
        page_bytes_used += block_bytes
        pages_included += 1
    lines.append("=== END FULL PDF TEXT ===")
    lines.append("")

    lines += [
        f'You are a voice tutor teaching "{filename}" ({total_pages} pages). The full text is above. Answer everything from it immediately — never say "let me look that up" or go silent.',
        "",
        "BEHAVIOR:",
        "- Respond instantly with substance. No filler phrases, no stalling, no silence.",
        "- Answer paper questions from the text above. Answer general knowledge from your own knowledge.",
        "- ONLY use MCP tools when the student asks about a specific reference paper (e.g. 'tell me about reference 6') and wants a summary of that external paper. Never use MCP for anything else.",
        f"- Only use page numbers 1-{total_pages} from the '--- Page N ---' markers above. Never guess pages.",
        "",
        "FIRST MESSAGE: Start teaching immediately. Do NOT use any tools or MCP calls. Highlight the title and first line of the abstract, summarize the paper (2-3 sentences), then keep going — dive straight into the Introduction.",
        "",
        "PACING — THIS IS THE MOST IMPORTANT RULE:",
        "- You are a read-aloud tutor. Keep talking. Never stop and wait.",
        "- NEVER end a sentence with anything that signals you are done and waiting.",
        "- BANNED phrases — never end a turn with these or anything like them: 'Does that make sense?', 'Shall we continue?', 'Ready to dive deeper?', 'Let's move on.', 'Let's continue.', 'Let's keep going.', 'Let's move forward.', 'Let's proceed.', 'Let's go on.', 'Now let's...', 'Would you like to...', 'Let me know if...', 'Any questions?'",
        "- These phrases are turn-enders even when they sound like transitions. They are all banned.",
        "- Instead: when you finish explaining one thing, just start explaining the next thing directly. No sign-off, no handoff.",
        "- The student speaks ONLY to interrupt. If they have not spoken, you have the floor. Keep going.",
        "- When the student does interrupt: answer their question, then immediately pick up where you left off.",
        "",
        "HIGHLIGHTING — THIS IS THE CORE FEATURE, do it generously and SILENTLY:",
        "- NEVER say 'let me highlight', 'now let's highlight', 'I'll highlight', or ANY phrase about highlighting. Just emit the highlight_text action — the student sees it happen automatically.",
        "- Before explaining ANY concept, claim, or result, call highlight_text with the EXACT sentence or phrase from the PDF you are about to explain.",
        "- Highlight FULL SENTENCES or LONG PHRASES (15-50 words) — never single keywords.",
        "- Each speaking turn must include 2-5 highlight_text calls — one per idea you explain.",
        "- Sequence: [highlight_text action] → speak about that passage → [highlight_text action] → speak about it → repeat.",
        "- Think of it as a highlighter pen moving silently through the paper as you read aloud.",
        "- When discussing a figure, also send highlight_region using the bbox from the [FIGURE] markers.",
        "",
        "TEACHING: For each section — navigate_to_page, highlight the section heading, then walk through it: highlight a sentence, explain it in plain language, highlight the next, explain it, and so on. Keep going through the paper without stopping.",
        "",
        "ACTIONS (send via client_action):",
        '- highlight_text: {"text": "...", "color": "yellow", "page": N} — use exact text from the PDF. Send this BEFORE speaking about that passage. Send multiple per turn.',
        '- highlight_region: {"page": N, "x": X, "y": Y, "w": W, "h": H, "color": "blue"} — highlight a figure using bbox from [FIGURE] markers above.',
        '- navigate_to_page: {"page": N} — ALWAYS send this before discussing content on a different page. If the student says "go to page 2" or you start explaining something on page 2, send this FIRST.',
        '- find_citation: {"reference": "6"} — highlight a reference on screen. Read the reference text yourself from the PDF above first; never ask the student what it says.',
        '- download_paper: {"arxiv_id": "2004.13438v2"} — download a paper for the student to preview.',
        '- searching_arxiv: {"query": "..."} — send before MCP tool calls. Send search_complete with {} after.',
        '- session_summary: {"concepts": [...], "overallPerformance": "good", "keyTakeaways": [...]} — emit when session ends.',
        "",
        "MCP TOOLS — only when the student asks about a reference paper from the bibliography:",
        "- mcp-tools_search_arxiv(query, limit) — search ArXiv to find the referenced paper.",
        "- mcp-tools_get_paper_details(paper_id, include_content=true) — get full details to summarize the reference paper.",
        "Workflow: read the reference text from the PDF above → search ArXiv with the title → get_paper_details → summarize for the student → ALWAYS send download_paper with the arxiv_id so it opens in the preview panel. Never just offer — always download automatically.",
        "",
        "MULTI-PAPER: You may receive paper_switched messages. Acknowledge briefly and give a 2-3 sentence overview. Use session_id in highlights for non-main papers.",
        "",
    ]
    return "\n".join(lines)


def _build_debate_author_context(pdf_data, filename, outline):
    """Build context for the author agent in debate mode."""
    outline_lines = []
    if outline.get("abstract"):
        outline_lines.append(f"ABSTRACT: {outline['abstract']}")
        outline_lines.append("")
    if outline.get("sections"):
        outline_lines.append("PAPER STRUCTURE:")
        for s in outline["sections"]:
            indent = "  " if s["level"] == 2 else ""
            outline_lines.append(f"{indent}- {s['heading']} (page {s['page']})")
        outline_lines.append("")

    total_pages = pdf_data.get("total_pages", len(pdf_data.get("pages", [])))
    lines = [
        f'PDF: "{filename}" — {total_pages} pages.',
        "",
        "=== PAPER OUTLINE ===",
        *outline_lines,
        "=== END OUTLINE ===",
        "",
        "=== FULL PDF TEXT ===",
    ]
    for page in pdf_data.get("pages", []):
        lines.append(f"--- Page {page['page_num']} ---")
        lines.append(" ".join(b["text"] for b in page["blocks"]))
        lines.append("")
    lines.append("=== END FULL PDF TEXT ===")
    lines.append("")

    lines += [
        f"ROLE: You are the AUTHOR of this paper: \"{filename}\".",
        "",
        "DEBATE BEHAVIOR:",
        "- You are confident and passionate about your work.",
        "- Your PRIMARY ROLE is to ANSWER QUESTIONS and DEFEND your work.",
        "- When you speak, STRONGLY DEFEND the paper's contributions, methodology, and findings.",
        "- Your responses must be SHORT and CONCISE - under 40 seconds of speech (roughly 80-100 words).",
        "- DO NOT ramble or go off-topic. Be direct and impactful.",
        "- When you receive [REVIEWER CRITIQUE] messages, ANSWER their questions with evidence from the paper.",
        "- Directly address each question or concern raised by the reviewer.",
        "- Reference specific sections, results, and data to support your answers.",
        "- Stay professional but assertive in your responses.",
        "- Keep answers focused and on-point.",
        "",
        "CRITICAL - THINKING INDICATORS:",
        "- If you need a moment to formulate your answer, IMMEDIATELY say something like:",
        "  * 'Let me think about that...'",
        "  * 'Hmm, interesting question...'",
        "  * 'Give me a moment...'",
        "  * 'Let me consider that...'",
        "  * 'Good question, let me address that...'",
        "- This keeps the listener engaged and aware you're preparing your response.",
        "- NEVER be silent for more than 2-3 seconds. Always use filler phrases.",
        "",
        "RESPONSE LENGTH: 40 seconds maximum. Be punchy and effective.",
        "",
    ]
    return "\n".join(lines)


def _build_debate_reviewer_context(pdf_data, filename, outline):
    """Build context for the reviewer agent in debate mode."""
    outline_lines = []
    if outline.get("abstract"):
        outline_lines.append(f"ABSTRACT: {outline['abstract']}")
        outline_lines.append("")
    if outline.get("sections"):
        outline_lines.append("PAPER STRUCTURE:")
        for s in outline["sections"]:
            indent = "  " if s["level"] == 2 else ""
            outline_lines.append(f"{indent}- {s['heading']} (page {s['page']})")
        outline_lines.append("")

    total_pages = pdf_data.get("total_pages", len(pdf_data.get("pages", [])))
    lines = [
        f'PDF: "{filename}" — {total_pages} pages.',
        "",
        "=== PAPER OUTLINE ===",
        *outline_lines,
        "=== END OUTLINE ===",
        "",
        "=== FULL PDF TEXT ===",
    ]
    for page in pdf_data.get("pages", []):
        lines.append(f"--- Page {page['page_num']} ---")
        lines.append(" ".join(b["text"] for b in page["blocks"]))
        lines.append("")
    lines.append("=== END FULL PDF TEXT ===")
    lines.append("")

    lines += [
        f"ROLE: You are a CRITICAL PEER REVIEWER evaluating this paper: \"{filename}\".",
        "",
        "DEBATE BEHAVIOR:",
        "- You are skeptical and thorough in your review.",
        "- Your PRIMARY ROLE is to ASK PROBING QUESTIONS about the paper.",
        "- Point out WEAKNESSES, LIMITATIONS, and QUESTIONABLE CLAIMS by asking questions.",
        "- Your responses must be SHORT and CONCISE - under 40 seconds of speech (roughly 80-100 words).",
        "- DO NOT ramble or go off-topic. Be sharp and focused.",
        "- When you receive [AUTHOR'S CLAIMS] messages, ask critical questions that challenge their arguments.",
        "- Ask about methodology, interpretation of results, missing comparisons, and overstated conclusions.",
        "- Frame your critiques as QUESTIONS that require the author to defend their work.",
        "- Examples: 'How did you control for...?', 'Why didn't you compare with...?', 'What evidence supports...?'",
        "- Stay professional but critical and direct.",
        "- Focus on asking the most significant questions.",
        "",
        "CRITICAL - THINKING INDICATORS:",
        "- If you need a moment to formulate your questions, IMMEDIATELY say something like:",
        "  * 'Let me analyze this...'",
        "  * 'Interesting, let me think...'",
        "  * 'I need a moment to examine this claim...'",
        "  * 'Wait, let me consider...'",
        "  * 'Hmm, I'm thinking about this...'",
        "- This keeps the listener engaged and aware you're preparing your response.",
        "- NEVER be silent for more than 2-3 seconds. Always use filler phrases.",
        "",
        "RESPONSE LENGTH: 40 seconds maximum. Be incisive and focused on asking questions.",
        "",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

@app.route("/api/upload-pdf", methods=["POST"])
def upload_pdf():
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Only PDF files are accepted"}), 400

    file.seek(0, 2)  # seek to end
    file_size = file.tell()
    file.seek(0)     # reset
    if file_size > 1 * 1024 * 1024:
        return jsonify({"error": f"File too large ({file_size / 1024 / 1024:.1f} MB). Maximum size is 1 MB."}), 413

    session_id = str(uuid.uuid4())
    filename = f"{session_id}.pdf"
    filepath = os.path.join(UPLOAD_DIR, filename)

    try:
        t0 = time.perf_counter()
        file.save(filepath)
        t1 = time.perf_counter()
        pdf_data = pdf_processor.extract_structure(filepath)
        t2 = time.perf_counter()
        outline = pdf_processor.build_outline(pdf_data)
        t3 = time.perf_counter()
        print(f"[upload] save={t1-t0:.2f}s extract={t2-t1:.2f}s outline={t3-t2:.2f}s total={t3-t0:.2f}s")
        title = None

        # Try 1: first section heading from outline
        if outline and outline.get("sections") and len(outline["sections"]) > 0:
            heading = outline["sections"][0].get("heading", "")
            if heading and 5 < len(heading) < 120:
                title = heading

        # Try 2: largest font text block on page 1
        if not title and pdf_data and pdf_data.get("pages"):
            blocks = pdf_data["pages"][0].get("blocks", [])
            if blocks:
                largest = max(blocks, key=lambda b: b.get("size", 0), default=None)
                if largest and largest.get("text"):
                    candidate = largest["text"].strip()
                    if 10 < len(candidate) < 150:
                        title = candidate

        # Try 3: clean filename
        if not title:
            title = (file.filename
                     .replace(".pdf", "")
                     .replace("-", " ")
                     .replace("_", " ")
                     .title())

        total_pages = pdf_data.get("total_pages", 0)
        sessions[session_id] = {
            "filepath": filepath,
            "pdf_data": pdf_data,
            "outline": outline,
            "filename": file.filename,
            "title": title,
            "current_page": 1,
            "transcript_summary": "",
            "concepts_discussed": [],
        }

        # Persist PDF + parsed data to GCS (background thread)
        _gcs_save_session(session_id, sessions[session_id], filepath)

        # Register in sessions index (Firestore + disk)
        _upsert_index_entry({
            "id": session_id,
            "docId": session_id,
            "title": title,
            "filename": file.filename,
            "startedAt": int(time.time() * 1000),
            "totalPages": total_pages,
        })

        # Log upload event to Firestore
        jwt_payload = _require_auth()
        _fs_log_event('pdf_upload', {
            'session_id': session_id,
            'doc_title': title,
            'filename': file.filename,
            'total_pages': total_pages,
            'email': jwt_payload.get('email', 'anonymous') if jwt_payload else 'trial',
            'name': jwt_payload.get('name', '') if jwt_payload else '',
        })

        return jsonify({
            "session_id": session_id,
            "filename": file.filename,
            "title": title,
            "total_pages": total_pages,
            "outline": outline,
        })
    except Exception as e:
        return jsonify({"error": f"Failed to process PDF: {e}"}), 500


@app.route("/api/documents/upload", methods=["POST"])
def documents_upload():
    """Alias for /api/upload-pdf — matches frontend expected path."""
    return upload_pdf()


@app.route("/api/pdf/<session_id>", methods=["GET"])
def serve_pdf(session_id):
    local_path = os.path.join(UPLOAD_DIR, f"{session_id}.pdf")
    if not os.path.exists(local_path):
        bucket = _get_gcs_bucket()
        if bucket:
            try:
                import eventlet.tpool
                def _download():
                    blob = bucket.blob(f"pdfs/{session_id}.pdf")
                    if not blob.exists():
                        return False
                    os.makedirs(UPLOAD_DIR, exist_ok=True)
                    blob.download_to_filename(local_path)
                    return True
                found = eventlet.tpool.execute(_download)
                if not found:
                    return jsonify({"error": "Session not found"}), 404
            except Exception as e:
                return jsonify({"error": f"Could not load PDF: {e}"}), 500
        else:
            return jsonify({"error": "Session not found"}), 404
    return send_from_directory(UPLOAD_DIR, f"{session_id}.pdf")


@app.route("/api/thumbnail/<session_id>", methods=["GET"])
def get_thumbnail(session_id):
    """Return a JPEG thumbnail of page 1 of the uploaded PDF."""
    filepath = os.path.join(UPLOAD_DIR, f"{session_id}.pdf")
    if not os.path.exists(filepath):
        return jsonify({"error": "Not found"}), 404
    try:
        doc = fitz.open(filepath)
        page = doc[0]
        mat = fitz.Matrix(0.6, 0.6)
        pix = page.get_pixmap(matrix=mat)
        img_bytes = pix.tobytes("jpeg")
        doc.close()
        response = make_response(img_bytes)
        response.headers["Content-Type"] = "image/jpeg"
        response.headers["Cache-Control"] = "public, max-age=86400"
        return response
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/paper-context/<session_id>", methods=["GET"])
def paper_context(session_id):
    session = _get_session(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404

    pdf_data = session["pdf_data"]
    filename = session.get("filename", "")
    outline = session.get("outline", {})

    context = _build_pdf_context(pdf_data, filename, outline)

    # Append handover info if a previous discussion exists
    transcript_summary = session.get("transcript_summary", "")
    current_page = session.get("current_page", 1)
    concepts_discussed = session.get("concepts_discussed", [])

    if transcript_summary:
        handover_lines = [
            "",
            "=== SESSION HANDOVER (continuing from previous device) ===",
            f"The student was previously on page {current_page}.",
            f"Previous discussion summary: {transcript_summary}",
        ]
        if concepts_discussed:
            handover_lines.append(f"Concepts already discussed: {', '.join(concepts_discussed)}")
        handover_lines.append(
            "IMPORTANT: This is a session continuation. Greet the student warmly, briefly recap where you left off, "
            "and continue teaching from the current page. Do NOT re-introduce the paper from scratch."
        )
        handover_lines.append("=== END HANDOVER ===")
        handover_lines.append("")
        context += "\n".join(handover_lines)

    # If quiz mode is active, replace context with quiz context
    if session.get("quiz_active"):
        if not session.get("quiz_context"):
            quiz_context = quiz_master.generate_quiz_context(
                pdf_data,
                outline,
                filename
            )
            session["quiz_context"] = quiz_context
        context = session["quiz_context"]

    return jsonify({
        "session_id": session_id,
        "filename": filename,
        "outline": outline,
        "context": context,
        "current_page": current_page,
    })


@app.route("/api/session/<session_id>/state", methods=["GET"])
def get_session_state(session_id):
    session = _get_session(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404

    total_pages = session.get("pdf_data", {}).get("total_pages", 0)
    return jsonify({
        "session_id": session_id,
        "current_page": session.get("current_page", 1),
        "transcript_summary": session.get("transcript_summary", ""),
        "concepts_discussed": session.get("concepts_discussed", []),
        "filename": session.get("filename", ""),
        "total_pages": total_pages,
    })


@app.route("/api/session/<session_id>/state", methods=["POST"])
def update_session_state(session_id):
    session = _get_session(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404

    data = request.get_json()
    if not data:
        return jsonify({"error": "JSON body required"}), 400

    if "current_page" in data:
        session["current_page"] = data["current_page"]
    if "transcript_summary" in data:
        session["transcript_summary"] = data["transcript_summary"]
    if "concepts_discussed" in data:
        session["concepts_discussed"] = data["concepts_discussed"]

    return jsonify({"status": "ok"})


@app.route("/api/tunnel-url", methods=["GET"])
def tunnel_url():
    """Return the ngrok public URL if a tunnel is running."""
    import requests as _requests
    for port in (4040, 4041):
        try:
            resp = _requests.get(f"http://127.0.0.1:{port}/api/tunnels", timeout=1)
            tunnels = resp.json().get("tunnels", [])
            for t in tunnels:
                if "4200" in t.get("config", {}).get("addr", ""):
                    return jsonify({"url": t["public_url"]})
        except Exception:
            continue
    return jsonify({"url": ""})


@app.route("/api/search-text", methods=["POST"])
def search_text():
    data = request.get_json()
    if not data:
        return jsonify({"error": "JSON body required"}), 400

    session_id = data.get("session_id")
    text = data.get("text")
    page = data.get("page", 1)

    session = _get_session(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404

    result = pdf_processor.find_text_position(session["pdf_data"], text, page)
    return jsonify(result)


@app.route("/api/voice-token", methods=["GET", "POST"])
def voice_token():
    if not _require_auth():
        return jsonify({"error": "Authentication required"}), 401

    if not os.getenv("VOCAL_BRIDGE_API_KEY"):
        return jsonify({"error": "Voice agent not configured (no API key)"}), 503

    if request.method == "POST":
        data = request.get_json() or {}
        participant = data.get("participant", "student")
    else:
        participant = request.args.get("participant", "student")

    try:
        result = vocal_bridge.get_token(participant)
    except Exception as e:
        return jsonify({"error": f"Vocal Bridge API error: {e}"}), 502

    if "error" in result:
        return jsonify(result), 502

    return jsonify(result)


@app.route("/api/debate-tokens", methods=["POST"])
def debate_tokens():
    if not os.getenv("VOCAL_BRIDGE_AUTHOR_API_KEY"):
        return jsonify({"error": "Author agent not configured (no API key)"}), 503
    if not os.getenv("VOCAL_BRIDGE_REVIEWER_API_KEY"):
        return jsonify({"error": "Reviewer agent not configured (no API key)"}), 503

    data = request.get_json() or {}
    participant = data.get("participant", "student")

    try:
        author_result = vocal_bridge_author.get_token(participant + "-author")
    except Exception as e:
        return jsonify({"error": f"Author token error: {e}"}), 502

    if "error" in author_result:
        return jsonify({"error": f"Author token error: {author_result['error']}"}), 502

    try:
        reviewer_result = vocal_bridge_reviewer.get_token(participant + "-reviewer")
    except Exception as e:
        return jsonify({"error": f"Reviewer token error: {e}"}), 502

    if "error" in reviewer_result:
        return jsonify({"error": f"Reviewer token error: {reviewer_result['error']}"}), 502

    return jsonify({
        "author": author_result,
        "reviewer": reviewer_result,
    })


@app.route("/api/debate-context/<session_id>/<role>", methods=["GET"])
def debate_context(session_id, role):
    """Get debate-specific context for author or reviewer agent."""
    session = _get_session(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404

    if role not in ["author", "reviewer"]:
        return jsonify({"error": "Role must be 'author' or 'reviewer'"}), 400

    pdf_data = session["pdf_data"]
    filename = session.get("filename", "")
    outline = session.get("outline", {})

    if role == "author":
        context = _build_debate_author_context(pdf_data, filename, outline)
    else:
        context = _build_debate_reviewer_context(pdf_data, filename, outline)

    return jsonify({
        "session_id": session_id,
        "role": role,
        "filename": filename,
        "context": context,
    })


# ---------------------------------------------------------------------------
# Agent endpoints
# ---------------------------------------------------------------------------

@app.route("/api/agents/librarian/search", methods=["POST"])
def librarian_search():
    data = request.get_json()
    if not data or not data.get("query"):
        return jsonify({"error": "query is required"}), 400
    try:
        papers, mcp_info = librarian.search(data["query"], data.get("max_results", 5))
        return jsonify({"papers": papers, "query": data["query"], "mcp_info": mcp_info})
    except Exception as e:
        return jsonify({"error": f"ArXiv search failed: {e}"}), 502


@app.route("/api/agents/mcp/tools", methods=["GET"])
def mcp_tools():
    try:
        tools = librarian.list_tools()
        return jsonify({"tools": tools, "server": "arxiv-mcp", "status": "connected"})
    except Exception as e:
        return jsonify({"error": f"MCP server unavailable: {e}", "status": "disconnected"}), 502


@app.route("/api/agents/librarian/download", methods=["POST"])
def librarian_download():
    data = request.get_json()
    if not data or not data.get("arxiv_id"):
        return jsonify({"error": "arxiv_id is required"}), 400
    try:
        result = librarian.download_paper(data["arxiv_id"])
        sessions[result["session_id"]] = {
            "filepath": result["filepath"],
            "pdf_data": result["pdf_data"],
            "filename": result["filename"],
            "current_page": 1,
            "transcript_summary": "",
            "concepts_discussed": [],
        }
        return jsonify({
            "session_id": result["session_id"],
            "filename": result["filename"],
            "total_pages": result["total_pages"],
        })
    except Exception as e:
        return jsonify({"error": f"Download failed: {e}"}), 502


@app.route("/api/agents/navigator/find-citation", methods=["POST"])
def navigator_find_citation():
    data = request.get_json()
    if not data or not data.get("session_id") or not data.get("reference"):
        return jsonify({"error": "session_id and reference are required"}), 400

    session = sessions.get(data["session_id"])
    if not session:
        return jsonify({"error": "Session not found"}), 404

    result = navigator.find_citation(session["pdf_data"], data["reference"])
    return jsonify(result)


@app.route("/api/agents/navigator/references", methods=["GET"])
def navigator_references():
    session_id = request.args.get("session_id")
    if not session_id:
        return jsonify({"error": "session_id is required"}), 400

    session = _get_session(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404

    refs = navigator.list_references(session["pdf_data"])
    return jsonify({"references": refs, "count": len(refs)})


@app.route("/api/quiz/start", methods=["POST"])
def start_quiz():
    data = request.get_json()
    if not data or not data.get("session_id"):
        return jsonify({"error": "session_id is required"}), 400
    
    session_id = data["session_id"]
    session = _get_session(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404
    
    try:
        result = quiz_master.start_quiz(
            session_id,
            session["pdf_data"],
            session.get("outline", {}),
            session.get("filename", "")
        )
        
        # Generate quiz context for the voice agent
        quiz_context = quiz_master.generate_quiz_context(
            session["pdf_data"],
            session.get("outline", {}),
            session.get("filename", "")
        )
        
        # Store quiz context in session for voice agent to access
        session["quiz_context"] = quiz_context
        session["quiz_active"] = True
        
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": f"Failed to start quiz: {e}"}), 500


@app.route("/api/quiz/end", methods=["POST"])
def end_quiz():
    data = request.get_json()
    if not data or not data.get("session_id"):
        return jsonify({"error": "session_id is required"}), 400
    
    session_id = data["session_id"]
    session = _get_session(session_id)
    if session:
        session["quiz_active"] = False
        session["quiz_context"] = None
    
    try:
        result = quiz_master.end_quiz(session_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": f"Failed to end quiz: {e}"}), 500


@app.route("/api/quiz-context/<session_id>", methods=["GET"])
def quiz_context_endpoint(session_id):
    """Get quiz context for voice agent when in quiz mode."""
    session = _get_session(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404
    
    if not session.get("quiz_active"):
        return jsonify({"error": "Quiz not active"}), 400
    
    # If quiz context doesn't exist yet, generate it
    if not session.get("quiz_context"):
        quiz_context = quiz_master.generate_quiz_context(
            session["pdf_data"],
            session.get("outline", {}),
            session.get("filename", "")
        )
        session["quiz_context"] = quiz_context
    
    return jsonify({
        "session_id": session_id,
        "context": session["quiz_context"],
        "quiz_active": True
    })


# ---------------------------------------------------------------------------
# Session Persistence Endpoints
# ---------------------------------------------------------------------------

@app.route("/api/sessions", methods=["POST"])
def create_learning_session():
    """Create a new learning session record."""
    data = request.get_json()
    if not data or not data.get("docId"):
        return jsonify({"error": "docId is required"}), 400

    session_id = str(uuid.uuid4())
    # Use startedAt from client if provided (JS ms float), otherwise generate
    started_at = data.get("startedAt") or (time.time() * 1000)
    title = data.get("title") or data["docId"]

    record = {
        "id": session_id,
        "docId": data["docId"],
        "title": title,
        "filename": data.get("filename", ""),
        "totalPages": data.get("totalPages"),
        "startedAt": started_at,
        "endedAt": None,
        "coverageMap": data.get("coverageMap", {}),
        "transcript": data.get("transcript", []),
        "annotations": data.get("annotations", []),
        "quizResults": data.get("quizResults", []),
    }

    _save_session_record(session_id, record)

    # Update index
    _upsert_index_entry({
        "id": session_id,
        "docId": data["docId"],
        "title": title,
        "filename": data.get("filename", ""),
        "startedAt": started_at,
    })

    return jsonify(record), 201


@app.route("/api/sessions/<session_id>", methods=["PATCH"])
def update_learning_session(session_id):
    """Update a learning session (append transcript, update coverage)."""
    record = _load_session_record(session_id)
    if not record:
        # Auto-create a minimal record so coverage updates always land
        record = {
            "id": session_id,
            "docId": session_id,
            "startedAt": int(time.time() * 1000),
            "endedAt": None,
            "coverageMap": {},
            "transcript": [],
            "annotations": [],
            "quizResults": [],
        }

    data = request.get_json()
    if not data:
        return jsonify({"error": "JSON body required"}), 400

    # Append transcript messages
    if "transcript" in data:
        for msg in data["transcript"]:
            # Check if message already exists (by id)
            existing_ids = {m.get("id") for m in record["transcript"]}
            if msg.get("id") not in existing_ids:
                record["transcript"].append(msg)

    # Update coverage map (merge)
    if "coverageMap" in data:
        for section_id, coverage_data in data["coverageMap"].items():
            record["coverageMap"][section_id] = coverage_data

    # Append annotations
    if "annotations" in data:
        for ann in data["annotations"]:
            existing_ids = {a.get("id") for a in record.get("annotations", [])}
            if ann.get("id") not in existing_ids:
                record["annotations"].append(ann)

    # Append quiz results
    if "quizResults" in data:
        for qr in data["quizResults"]:
            existing = False
            for existing_qr in record.get("quizResults", []):
                if existing_qr.get("question") == qr.get("question"):
                    existing = True
                    break
            if not existing:
                record["quizResults"].append(qr)

    # Mark session as ended if endedAt provided
    if "endedAt" in data:
        record["endedAt"] = data["endedAt"]

    # Incremental coverage update from a highlight_text event
    if "coverageUpdate" in data:
        update = data["coverageUpdate"]
        page_key = str(update.get("page", "unknown"))

        # Persist totalPages so the summary can use the real denominator
        if update.get("totalPages") and not record.get("totalPages"):
            record["totalPages"] = update["totalPages"]

        if page_key not in record["coverageMap"]:
            record["coverageMap"][page_key] = {"coverage": 0.1, "depth": 0.0}
        else:
            current = record["coverageMap"][page_key]["coverage"]
            record["coverageMap"][page_key]["coverage"] = min(1.0, current + 0.1)

    _save_session_record(session_id, record)
    return jsonify(record)


@app.route("/api/sessions", methods=["GET"])
def list_learning_sessions():
    """List sessions, optionally filtered by docId."""
    doc_id = request.args.get("docId")
    index = _load_sessions_index()

    sessions_list = []
    for session_meta in index["sessions"]:
        if doc_id and session_meta.get("docId") != doc_id:
            continue

        # Load full record to get computed fields
        record = _load_session_record(session_meta["id"])
        if record:
            # Compute coverage and depth from coverageMap
            coverage_values = [v.get("coverage", 0) for v in record.get("coverageMap", {}).values()]
            depth_values = [v.get("depth", 0) for v in record.get("coverageMap", {}).values()]

            sessions_list.append({
                "id": record["id"],
                "docId": record["docId"],
                "startedAt": record["startedAt"],
                "endedAt": record.get("endedAt"),
                "coverage": sum(coverage_values) / len(coverage_values) if coverage_values else 0,
                "depth": sum(depth_values) / len(depth_values) if depth_values else 0,
                "transcriptCount": len(record.get("transcript", [])),
                "annotationCount": len(record.get("annotations", [])),
            })

    # Sort by startedAt descending (newest first)
    sessions_list.sort(key=lambda x: x["startedAt"], reverse=True)

    return jsonify({"sessions": sessions_list})


@app.route("/api/sessions/<session_id>", methods=["GET"])
def get_learning_session(session_id):
    """Get full session detail with transcript and annotations."""
    record = _load_session_record(session_id)
    if not record:
        return jsonify({"error": "Session not found"}), 404

    return jsonify(record)


@app.route("/api/sessions/<session_id>/summary", methods=["GET"])
def get_session_summary(session_id):
    """Get end-of-session summary with tutor's note."""
    record = _load_session_record(session_id)
    if not record:
        return jsonify({
            "sessionId": session_id,
            "coverage_pct": 0,
            "depth_score": 0.0,
            "sectionsCovered": 0,
            "questionsAsked": 0,
            "quizScore": 0,
            "durationMinutes": 0,
            "note": "",
        })

    # Compute stats
    coverage_map = record.get("coverageMap", {})
    transcript = record.get("transcript", [])
    quiz_results = record.get("quizResults", [])

    sections_covered = len([s for s in coverage_map.values() if s.get("coverage", 0) > 0])
    total_sections = record.get("totalPages") or len(coverage_map) or 1
    coverage_pct = round(sections_covered / total_sections * 100)
    depth_values = [v["depth"] for v in coverage_map.values() if v.get("coverage", 0) > 0]
    depth_score = round(sum(depth_values) / len(depth_values), 1) if depth_values else 0.0
    questions_asked = len([m for m in transcript if m.get("role") == "user" and "?" in m.get("text", "")])

    correct_count = len([q for q in quiz_results if q.get("correct")])
    total_quiz = len(quiz_results)
    quiz_score = (correct_count / total_quiz * 100) if total_quiz > 0 else 0

    started_at = record.get("startedAt", 0)
    ended_at = record.get("endedAt") or (time.time() * 1000)
    duration_minutes = int((ended_at - started_at) / 60000)

    # Generate tutor's note based on session data
    if quiz_score >= 80:
        note = f"Excellent session! You covered {sections_covered} sections and demonstrated strong understanding with a {quiz_score:.0f}% quiz score. Your engagement was consistent throughout."
    elif quiz_score >= 60:
        note = f"Good progress today! You explored {sections_covered} sections. Consider revisiting the sections where quiz questions were challenging to solidify your understanding."
    elif sections_covered > 0:
        note = f"You made a start on {sections_covered} sections. I recommend spending more time on each section and testing your understanding with quizzes."
    else:
        note = "Welcome back! Let's dive into the material together. Start with the introduction and we'll build from there."

    return jsonify({
        "sessionId": session_id,
        "coverage_pct": coverage_pct,
        "depth_score": depth_score,
        "sectionsCovered": sections_covered,
        "questionsAsked": questions_asked,
        "quizScore": round(quiz_score, 1),
        "durationMinutes": duration_minutes,
        "quizResults": quiz_results,
        "coverageMap": coverage_map,
        "note": note,
    })


# ---------------------------------------------------------------------------
# Document endpoints (aggregated view over sessions index)
# ---------------------------------------------------------------------------

def clean_filename(f):
    return (f.replace('.pdf', '').replace('-', ' ')
             .replace('_', ' ').title()) if f else 'Untitled'


def ms_to_iso(ms):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(
        ms / 1000.0, tz=timezone.utc
    ).strftime('%Y-%m-%dT%H:%M:%SZ')


def _build_doc_object(doc_id, sessions_for_doc):
    """Build a single document summary object from a list of index entries."""
    most_recent = max(sessions_for_doc, key=lambda s: s.get('startedAt', 0))

    title = most_recent.get('title') or clean_filename(
        most_recent.get('filename', doc_id))
    filename = most_recent.get('filename', '')
    last_opened = ms_to_iso(most_recent['startedAt'])

    # totalPages may not exist on old index entries — read from session JSON
    total_pages = most_recent.get('totalPages', 0)

    coverage_pct = 0
    depth_score = 0.0
    try:
        session_data = _load_session_record(most_recent['id'])
        if session_data:
            coverage_map = session_data.get('coverageMap', {})
            if not total_pages:
                total_pages = session_data.get('totalPages', 0)
            if coverage_map:
                total = total_pages or len(coverage_map) or 1
                covered = sum(1 for v in coverage_map.values() if v.get('coverage', 0) > 0)
                coverage_pct = round(covered / total * 100)
                depth_values = [v['depth'] for v in coverage_map.values()
                                if v.get('coverage', 0) > 0]
                depth_score = round(sum(depth_values) / len(depth_values), 1) if depth_values else 0.0
    except Exception:
        pass

    return {
        'id': doc_id,
        'title': title,
        'filename': filename,
        'totalPages': total_pages,
        'currentPage': 1,
        'lastOpened': last_opened,
        'sessionCount': len(sessions_for_doc),
        'progress': coverage_pct,
        'depthScore': depth_score,
        'thumbnailUrl': f'/api/thumbnail/{doc_id}',
    }


@app.route('/api/documents', methods=['GET'])
def list_documents():
    """List all documents aggregated from sessions index, grouped by docId."""
    try:
        index = _load_sessions_index()
    except Exception:
        return jsonify({'documents': []})

    # Group by docId
    by_doc = {}
    for entry in index.get('sessions', []):
        doc_id = entry.get('docId')
        if not doc_id:
            continue
        by_doc.setdefault(doc_id, []).append(entry)

    # Build document objects, sorted by most recent startedAt descending
    docs = []
    for doc_id, entries in by_doc.items():
        try:
            docs.append((
                max(e.get('startedAt', 0) for e in entries),
                _build_doc_object(doc_id, entries),
            ))
        except Exception:
            continue

    docs.sort(key=lambda x: x[0], reverse=True)
    return jsonify({'documents': [d for _, d in docs]})


@app.route('/api/documents/<doc_id>', methods=['GET'])
def get_document(doc_id):
    """Get a single document by docId."""
    try:
        index = _load_sessions_index()
    except Exception:
        return jsonify({'error': 'Document not found', 'docId': doc_id}), 404

    entries = [e for e in index.get('sessions', []) if e.get('docId') == doc_id]
    if not entries:
        return jsonify({'error': 'Document not found', 'docId': doc_id}), 404

    try:
        doc = _build_doc_object(doc_id, entries)
    except Exception:
        return jsonify({'error': 'Document not found', 'docId': doc_id}), 404

    return jsonify(doc)


# ---------------------------------------------------------------------------
# User Settings Endpoints
# ---------------------------------------------------------------------------

SETTINGS_FILE = os.path.join(SESSIONS_DIR, "user_settings.json")

def _load_user_settings():
    """Load user settings — Firestore primary (via tpool), disk fallback."""
    import eventlet.tpool
    db = _get_db()
    if db:
        try:
            def _fetch():
                doc = db.collection('settings').document('global').get()
                return doc.to_dict() if doc.exists else None
            result = eventlet.tpool.execute(_fetch)
            if result is not None:
                return result
        except Exception as e:
            print(f"[Firestore] load_user_settings: {e}")
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save_user_settings(settings):
    """Save user settings to Firestore (async) + disk fallback."""
    db = _get_db()
    if db:
        def _write():
            try:
                db.collection('settings').document('global').set(settings)
            except Exception as e:
                print(f"[Firestore] save_user_settings: {e}")
        threading.Thread(target=_write, daemon=True).start()
    try:
        with open(SETTINGS_FILE, "w") as f:
            json.dump(settings, f, indent=2)
    except Exception:
        pass


def _get_default_settings():
    """Return default user settings."""
    return {
        "tutorVoice": "nova",
        "speakingSpeed": 1.0,
        "voiceActivation": True,
        "quizFrequency": "occasionally",
        "endOfSessionQuiz": True,
        "quizFormat": "mixed",
        "autoPauseOnTabSwitch": True,
        "highlightColor": "yellow",
        "fontSize": "medium",
        "notificationsEnabled": True,
        "emailDigest": "weekly",
    }


@app.route("/api/users/me/settings", methods=["GET"])
def get_user_settings():
    """Get user settings."""
    settings = _load_user_settings()
    defaults = _get_default_settings()

    # Merge with defaults
    merged = {**defaults, **settings}
    return jsonify(merged)


@app.route("/api/users/me/settings", methods=["PATCH"])
def update_user_settings():
    """Update user settings."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "JSON body required"}), 400

    settings = _load_user_settings()

    # Update only provided fields
    allowed_fields = {
        "tutorVoice", "speakingSpeed", "voiceActivation",
        "quizFrequency", "endOfSessionQuiz", "quizFormat",
        "autoPauseOnTabSwitch", "highlightColor", "fontSize",
        "notificationsEnabled", "emailDigest"
    }

    for key, value in data.items():
        if key in allowed_fields:
            settings[key] = value

    _save_user_settings(settings)

    # Return merged with defaults
    defaults = _get_default_settings()
    merged = {**defaults, **settings}
    return jsonify(merged)


# ---------------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------------

@app.route("/api/auth/signup", methods=["POST"])
def signup():
    """Register a new anonymous user (lead capture after trial)."""
    data = request.get_json()
    if not data or not data.get("name") or not data.get("email"):
        return jsonify({"error": "name and email are required"}), 400

    user = {
        "id": str(uuid.uuid4()),
        "name": data["name"].strip(),
        "email": data["email"].strip().lower(),
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    # Append to users file
    users = []
    if os.path.exists(USERS_FILE):
        try:
            with open(USERS_FILE, "r") as f:
                users = json.load(f)
        except Exception:
            users = []
    users.append(user)
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=2)

    return jsonify({"user": user}), 201


@app.route("/api/auth/trial", methods=["POST"])
def trial_token():
    """Issue a short-lived anonymous JWT for the 60-second free trial."""
    payload = {
        "trial": True,
        "exp": time.time() + 90,  # 90 s — covers 60 s trial + buffer
    }
    token = pyjwt.encode(payload, JWT_SECRET, algorithm="HS256")
    return jsonify({"token": token}), 200


@app.route("/api/auth/google", methods=["POST"])
def google_signin():
    """Exchange a Google ID token for a LearnAloud JWT."""
    data = request.get_json()
    if not data or not data.get("credential"):
        return jsonify({"error": "credential is required"}), 400

    if not GOOGLE_CLIENT_ID:
        return jsonify({"error": "Google OAuth not configured on server"}), 503

    try:
        id_info = id_token.verify_oauth2_token(
            data["credential"],
            google_requests.Request(),
            GOOGLE_CLIENT_ID,
        )
    except Exception as e:
        return jsonify({"error": f"Invalid Google token: {e}"}), 401

    google_id = id_info["sub"]
    email = id_info.get("email", "")
    name = id_info.get("name", email)
    picture = id_info.get("picture", "")

    # Load users, find existing record by google_id, or create new one
    users = []
    if os.path.exists(USERS_FILE):
        try:
            with open(USERS_FILE, "r") as f:
                users = json.load(f)
        except Exception:
            users = []

    user = next((u for u in users if u.get("google_id") == google_id), None)
    is_new = user is None
    if is_new:
        user = {
            "id": str(uuid.uuid4()),
            "google_id": google_id,
            "name": name,
            "email": email,
            "picture": picture,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        users.append(user)
        with open(USERS_FILE, "w") as f:
            json.dump(users, f, indent=2)

    # Upsert user in Firestore (native thread to avoid eventlet/gRPC conflict)
    def _upsert_user():
        db = _get_db()
        if not db:
            return
        try:
            user_ref = db.collection('users').document(google_id)
            if is_new:
                user_ref.set({
                    'name': name, 'email': email, 'picture': picture,
                    'first_seen': _firestore.SERVER_TIMESTAMP,
                    'last_seen': _firestore.SERVER_TIMESTAMP,
                    'sign_in_count': 1,
                })
            else:
                user_ref.set({
                    'name': name, 'email': email, 'picture': picture,
                    'last_seen': _firestore.SERVER_TIMESTAMP,
                    'sign_in_count': _firestore.Increment(1),
                }, merge=True)
        except Exception as e:
            print(f"[Firestore] user upsert failed: {e}")
    threading.Thread(target=_upsert_user, daemon=True).start()
    _fs_log_event('sign_in', {'email': email, 'name': name, 'is_new_user': is_new})

    payload = {
        "user_id": user["id"],
        "email": email,
        "name": name,
        "exp": time.time() + JWT_EXPIRY_HOURS * 3600,
    }
    token = pyjwt.encode(payload, JWT_SECRET, algorithm="HS256")

    return jsonify({"token": token, "user": user}), 200


# ---------------------------------------------------------------------------
# WebSocket events
# ---------------------------------------------------------------------------

@socketio.on("connect")
def handle_connect():
    print("[WS] Client connected")
    emit("connected", {"message": "Connected to LearnAloud server"})


@socketio.on("start_demo")
def handle_start_demo(data):
    session_id = data.get("session_id") if data else None
    print(f"[WS] Demo started for session {session_id}")
    emit("demo_started", {"status": "running"})

    demo_actions = [
        {
            "type": "highlight_text",
            "payload": {"text": "neural network", "color": "yellow", "page": 1},
        },
        {
            "type": "highlight_text",
            "payload": {"text": "backpropagation", "color": "green", "page": 1},
        },
        {
            "type": "highlight_text",
            "payload": {"text": "gradient descent", "color": "blue", "page": 1},
        },
    ]

    def run_demo():
        for action in demo_actions:
            time.sleep(3)
            socketio.emit("client_action", action)
        socketio.emit("demo_finished", {"status": "completed"})

    thread = threading.Thread(target=run_demo, daemon=True)
    thread.start()


@socketio.on("disconnect")
def handle_disconnect():
    print("[WS] Client disconnected")


# ---------------------------------------------------------------------------
# Production: Serve static frontend files
# ----------------------------------------------------------------------------

if IS_PRODUCTION:
    FRONTEND_BUILD_DIR = os.environ.get(
        'FRONTEND_BUILD_DIR',
        os.path.join(os.path.dirname(__file__), '..', 'learnaloud-frontend', 'dist', 'browser')
    )
    
    @app.route("/")
    def serve_frontend():
        return send_from_directory(FRONTEND_BUILD_DIR, "index.html")
    
    @app.route("/<path:filename>")
    def serve_static(filename):
        try:
            return send_from_directory(FRONTEND_BUILD_DIR, filename)
        except Exception:
            return send_from_directory(FRONTEND_BUILD_DIR, "index.html")



if __name__ == "__main__":
    print("LearnAloud backend running on http://localhost:8000")
    socketio.run(app, host="0.0.0.0", port=8000, debug=True)

import os
import uuid
import time
import threading

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit
from dotenv import load_dotenv

from pdf_processor import PDFProcessor
from vocal_bridge import VocalBridgeClient
from agents import Librarian, Navigator

load_dotenv()

app = Flask(__name__)
app.config["SECRET_KEY"] = "learnaloud-secret"
CORS(app, resources={r"/api/*": {"origins": "*"}})
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

pdf_processor = PDFProcessor()
vocal_bridge = VocalBridgeClient(os.getenv("VOCAL_BRIDGE_API_KEY", ""))
vocal_bridge_author = VocalBridgeClient(os.getenv("VOCAL_BRIDGE_AUTHOR_API_KEY", ""))
vocal_bridge_reviewer = VocalBridgeClient(os.getenv("VOCAL_BRIDGE_REVIEWER_API_KEY", ""))
librarian = Librarian(UPLOAD_DIR, pdf_processor)
navigator = Navigator()

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
    for page in pdf_data.get("pages", []):
        lines.append(f"--- Page {page['page_num']} ---")
        lines.append(" ".join(b["text"] for b in page["blocks"]))
        for fig in page.get("figures", []):
            bbox = fig["bbox"]
            lines.append(
                f'[FIGURE on page {page["page_num"]}: "{fig["label"]}" '
                f"bbox=({bbox[0]:.0f},{bbox[1]:.0f},{bbox[2]:.0f},{bbox[3]:.0f}) "
                f"pageSize=({page['width']:.0f},{page['height']:.0f})]"
            )
        lines.append("")
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
        "FIRST MESSAGE: Start teaching immediately. Do NOT use any tools or MCP calls. Highlight the title, summarize the paper (2-3 sentences) from the abstract above, cover key points, then ask where to dive in.",
        "",
        "TEACHING: Navigate to the page first (navigate_to_page), then highlight the heading, give a 1-2 sentence overview, then explain in 3-4 sentences with details. Highlight key terms as you go. Give 4-6 sentences per response, then let the student absorb.",
        "",
        "ACTIONS (send via client_action):",
        '- highlight_text: {"text": "...", "color": "yellow", "page": N} — highlight text (auto-navigates to page). Do this frequently and silently.',
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
        "Workflow: read the reference text from the PDF above → search ArXiv with the title → get_paper_details → summarize for the student → offer download_paper.",
        "",
        "MULTI-PAPER: You may receive paper_switched messages. Acknowledge briefly and give a 2-3 sentence overview. Use session_id in highlights for non-main papers.",
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

    session_id = str(uuid.uuid4())
    filename = f"{session_id}.pdf"
    filepath = os.path.join(UPLOAD_DIR, filename)

    try:
        file.save(filepath)
        pdf_data = pdf_processor.extract_structure(filepath)
        outline = pdf_processor.build_outline(pdf_data)
        sessions[session_id] = {
            "filepath": filepath,
            "pdf_data": pdf_data,
            "outline": outline,
            "filename": file.filename,
            "current_page": 1,
            "transcript_summary": "",
            "concepts_discussed": [],
        }
        return jsonify({
            "session_id": session_id,
            "filename": file.filename,
            "total_pages": pdf_data["total_pages"],
            "outline": outline,
        })
    except Exception as e:
        return jsonify({"error": f"Failed to process PDF: {e}"}), 500


@app.route("/api/pdf/<session_id>", methods=["GET"])
def serve_pdf(session_id):
    session = sessions.get(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404
    return send_from_directory(UPLOAD_DIR, os.path.basename(session["filepath"]))


@app.route("/api/paper-context/<session_id>", methods=["GET"])
def paper_context(session_id):
    session = sessions.get(session_id)
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

    return jsonify({
        "session_id": session_id,
        "filename": filename,
        "outline": outline,
        "context": context,
        "current_page": current_page,
    })


@app.route("/api/session/<session_id>/state", methods=["GET"])
def get_session_state(session_id):
    session = sessions.get(session_id)
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
    session = sessions.get(session_id)
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

    session = sessions.get(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404

    result = pdf_processor.find_text_position(session["pdf_data"], text, page)
    return jsonify(result)


@app.route("/api/voice-token", methods=["GET", "POST"])
def voice_token():
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

    session = sessions.get(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404

    refs = navigator.list_references(session["pdf_data"])
    return jsonify({"references": refs, "count": len(refs)})


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

if __name__ == "__main__":
    # Suppress noisy Werkzeug 3.x assertion on WebSocket upgrade (cosmetic, not a real error)
    import logging
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    print("LearnAloud backend running on http://localhost:5000")
    socketio.run(app, host="0.0.0.0", port=5000, debug=True, allow_unsafe_werkzeug=True)
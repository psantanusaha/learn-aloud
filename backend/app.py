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

load_dotenv()

app = Flask(__name__)
app.config["SECRET_KEY"] = "learnaloud-secret"
CORS(app, resources={r"/api/*": {"origins": "*"}})
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

pdf_processor = PDFProcessor()
vocal_bridge = VocalBridgeClient(os.getenv("VOCAL_BRIDGE_API_KEY", ""))

# In-memory session store: session_id -> {filepath, pdf_data, filename}
sessions = {}


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
        sessions[session_id] = {
            "filepath": filepath,
            "pdf_data": pdf_data,
            "filename": file.filename,
        }
        return jsonify({
            "session_id": session_id,
            "filename": file.filename,
            "total_pages": pdf_data["total_pages"],
        })
    except Exception as e:
        return jsonify({"error": f"Failed to process PDF: {e}"}), 500


@app.route("/api/pdf/<session_id>", methods=["GET"])
def serve_pdf(session_id):
    session = sessions.get(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404
    return send_from_directory(UPLOAD_DIR, os.path.basename(session["filepath"]))


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


@app.route("/api/voice-token", methods=["GET"])
def voice_token():
    participant = request.args.get("participant", "student")
    result = vocal_bridge.get_token(participant)
    return jsonify(result)


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
    print("LearnAloud backend running on http://localhost:5000")
    socketio.run(app, host="0.0.0.0", port=5000, debug=True, allow_unsafe_werkzeug=True)

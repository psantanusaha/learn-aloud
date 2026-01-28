# LearnAloud POC - Voice-Synchronized PDF Teaching Assistant

A proof-of-concept application demonstrating synchronized voice teaching with PDF annotations. An AI tutor highlights text in a PDF in real-time, simulating voice-synchronized visual teaching.

## Tech Stack

- **Backend:** Python / Flask with WebSocket (Flask-SocketIO), PyMuPDF for PDF processing
- **Frontend:** Angular 21 with PDF.js for rendering, Socket.IO client

## Project Structure

```
learn-aloud/
├── backend/
│   ├── app.py              # Flask application with REST + WebSocket endpoints
│   ├── pdf_processor.py    # PDF text extraction using PyMuPDF
│   ├── vocal_bridge.py     # Vocal Bridge API client
│   ├── requirements.txt
│   ├── uploads/            # Uploaded PDFs stored here
│   └── .env                # API keys
└── learnaloud-frontend/    # Angular application
    └── src/
        └── app/
            ├── components/pdf-viewer/  # PDF rendering & highlighting
            ├── services/api.service.ts # REST + WebSocket client
            ├── app.ts                  # Main app component
            ├── app.html
            └── app.css
```

## Running the Application

### Terminal 1 - Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

The backend runs on http://localhost:5000.

### Terminal 2 - Frontend

```bash
cd learnaloud-frontend
npm install
npx ng serve
```

Then open http://localhost:4200.

## Testing

1. Upload any PDF with searchable text (a technical document about neural networks works best for the demo).
2. Click **Start Teaching Demo**.
3. Observe highlights appearing on the PDF every 3 seconds:
   - "neural network" highlighted in yellow
   - "backpropagation" highlighted in green
   - "gradient descent" highlighted in blue
4. Check the browser console for WebSocket messages.

## How It Works

1. The frontend uploads a PDF to the Flask backend, which extracts text structure using PyMuPDF.
2. PDF.js renders the document in the browser with a transparent text layer overlay.
3. When the demo starts, the backend emits `client_action` events over WebSocket at 3-second intervals.
4. The frontend receives each action and highlights matching text spans with a color fade-in animation, scrolling to bring them into view.

In production, these highlight commands will come from the Vocal Bridge AI voice agent via LiveKit, synchronized with actual speech.

## Configuration

Set `VOCAL_BRIDGE_API_KEY` in `backend/.env` to connect to the live Vocal Bridge API for voice token generation.

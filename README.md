# LearnAloud

**AI voice tutor that reads academic papers aloud with real-time PDF highlighting.**

Upload a PDF, and an AI tutor reads it to you — highlighting the exact passage being explained, navigating pages, and adapting to your questions in real time. Built for deep reading of research papers.

🏆 **1st place — DeepLearning.AI Vocal Bridge Hackathon**

**Live app:** https://learnaloud-6rego5ucxa-uc.a.run.app

---

## What it does

- **Voice-synchronized highlighting** — tutor highlights the exact sentence being explained as it speaks
- **Continuous read-aloud** — tutor reads the full paper without pausing, student can interrupt any time
- **Push-to-talk** — mic auto-mutes while tutor speaks to prevent echo; hold button to interrupt
- **Quiz on demand** — say "Quiz me" at any point; depth score tracks how well you're engaging
- **Text chat** — type questions if you can't speak
- **Coverage + Depth tracking** — topbar shows % of document covered and engagement depth score (0–5)
- **Document library** — upload and revisit multiple papers
- **Google Sign-In** — 60-second free trial, then Google OAuth for continued access
- **Usage analytics** — Firestore logs every sign-in and PDF upload

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Angular 21, standalone components |
| Voice / realtime | LiveKit WebRTC (via VocalBridge AI) |
| PDF rendering | pdf.js (dynamic import) |
| Backend | Python 3.12, Flask, eventlet |
| Auth | Google OAuth 2.0 + HS256 JWT |
| Analytics | Google Analytics 4 + Google Cloud Firestore |
| Deployment | Google Cloud Run (single container) |
| CI/CD | GitHub Actions → Artifact Registry → Cloud Run |

---

## Project structure

```
learn-aloud/
├── backend/                  # Flask API
│   ├── app.py                # All API routes, auth, Firestore logging
│   ├── pdf_processor.py      # PyMuPDF text + figure extraction
│   ├── vocal_bridge.py       # VocalBridge API client (LiveKit tokens)
│   ├── agents/               # Librarian, Navigator, QuizMaster agents
│   ├── prompts/              # Agent system prompt versions + manage_prompts.py
│   ├── session_data/         # Runtime session index + users.json
│   └── requirements.txt
├── learnaloud-frontend/      # Angular app
│   ├── src/app/
│   │   ├── session-view/     # Main session UI (PDF + voice panel)
│   │   ├── library/          # Document library
│   │   ├── services/
│   │   │   ├── voice.service.ts    # LiveKit connection, PTT, context send
│   │   │   ├── api.service.ts      # HTTP client
│   │   │   └── session.service.ts  # Progress polling
│   │   └── components/
│   │       ├── pdf-viewer/         # pdf.js viewer with fuzzy highlight matching
│   │       └── shared/waveform/    # Animated waveform component
│   └── src/styles.css        # Design tokens (CSS variables)
├── Dockerfile                # Multi-stage: Node build → Python runtime
└── .github/workflows/
    └── deploy.yml            # Push to main → build → Cloud Run deploy
```

---

## Local development

### Prerequisites

- Python 3.10+
- Node.js 18+
- A [VocalBridge](https://vocalbridgeai.com) API key

### Backend setup

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Create `backend/.env`:

```env
VOCAL_BRIDGE_API_KEY=your-key-here
GOOGLE_CLIENT_ID=your-oauth-client-id.apps.googleusercontent.com
JWT_SECRET=any-long-random-string
```

Run:

```bash
python app.py          # http://localhost:8000
```

### Frontend setup

```bash
cd learnaloud-frontend
npm install
ng serve               # http://localhost:4200
```

The Angular dev server proxies `/api/*` to `localhost:8000`.

---

## Environment variables

| Variable | Where | Description |
|---|---|---|
| `VOCAL_BRIDGE_API_KEY` | backend `.env` / Cloud Run | VocalBridge API key for voice tokens |
| `GOOGLE_CLIENT_ID` | backend `.env` / Cloud Run | OAuth 2.0 client ID |
| `JWT_SECRET` | backend `.env` / Cloud Run | Secret for signing JWTs |
| `FLASK_ENV` | Cloud Run | Set to `production` |
| `FRONTEND_BUILD_DIR` | Cloud Run | `/app/static/browser` |
| `GCP_PROJECT_ID` | Cloud Run | `learnaloud-app` (for Firestore) |

---

## Deployment

The app runs as a **single Docker container** on Google Cloud Run — Flask serves both the Angular static files and the API.

### How it works

1. Push to `main` branch
2. GitHub Actions builds a multi-stage Docker image:
   - Stage 1 (Node 20): `ng build --configuration production`
   - Stage 2 (Python 3.12): installs backend deps, copies Angular build to `/app/static/browser`
3. Image is pushed to Google Artifact Registry
4. Cloud Run is updated to the new image

### Infrastructure

| Resource | Value |
|---|---|
| GCP project | `learnaloud-app` |
| Cloud Run service | `learnaloud` (us-central1) |
| URL | https://learnaloud-6rego5ucxa-uc.a.run.app |
| Min instances | 0 (scales to zero) |
| Max instances | 1 |
| Memory | 1 GiB |
| Firestore database | `(default)` us-central1 |

### Required GitHub secrets

| Secret | Description |
|---|---|
| `GCP_SA_KEY` | Service account JSON key for `github-deploy@learnaloud-app` |
| `GCP_PROJECT_ID` | `learnaloud-app` |
| `VOCAL_BRIDGE_API_KEY` | VocalBridge API key |
| `GOOGLE_CLIENT_ID` | OAuth client ID |
| `JWT_SECRET` | JWT signing secret |

### Manual deploy (without CI)

```bash
gcloud auth configure-docker us-central1-docker.pkg.dev
IMAGE=us-central1-docker.pkg.dev/learnaloud-app/learnaloud/app:latest
docker build -t $IMAGE .
docker push $IMAGE
gcloud run deploy learnaloud --image $IMAGE --region us-central1
```

---

## Agent prompt management

The tutor's system prompt is versioned in `backend/prompts/vocalbridge_agent_system_prompt.json`. The **active prompt lives on the VocalBridge dashboard** — this file is the version history.

```bash
cd backend

# See all versions
python3 prompts/manage_prompts.py list

# Print current prompt (copy to VocalBridge dashboard)
python3 prompts/manage_prompts.py current tutor

# Roll back to a previous version
python3 prompts/manage_prompts.py rollback tutor v5
```

Current version: **v6** — continuous read-aloud, max 2 highlights per turn, structural mandate to end on content sentences.

---

## Analytics

Sign-ins and PDF uploads are logged to **Google Cloud Firestore** (`learnaloud-app`).

| Collection | Contents |
|---|---|
| `users` | One doc per user: name, email, first_seen, last_seen, sign_in_count |
| `events` | All sign_in and pdf_upload events with timestamp |

View at: https://console.cloud.google.com/firestore/databases/-default-/data/panel/users?project=learnaloud-app

Google Analytics 4 (measurement ID `G-3QRG5FRF7W`) tracks page views and login events.

---

## Google OAuth setup

The OAuth client is in GCP project `learnaloud-app` → APIs & Services → Credentials.

Authorized JavaScript origins must include:
- `http://localhost:4200` (local dev)
- `https://learnaloud-6rego5ucxa-uc.a.run.app` (production)

---

## Known limitations

- Uploaded PDFs are stored on the container filesystem — lost on Cloud Run cold start (ephemeral storage)
- Max PDF size: 1 MB
- No mobile layout (desktop-first)
- Echo cancellation relies on browser AEC + PTT; headphones give best results
- Non-English PDFs not tested

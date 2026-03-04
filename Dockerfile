# ── Stage 1: Build Angular frontend ──────────────────────────────────────────
FROM node:20-alpine AS frontend
WORKDIR /frontend
COPY learnaloud-frontend/package*.json ./
RUN npm ci --prefer-offline
COPY learnaloud-frontend/ ./
RUN npm run build -- --configuration production

# ── Stage 2: Python backend + static files ────────────────────────────────────
FROM python:3.12-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./

# Angular build goes here — Flask serves it as static files in production
COPY --from=frontend /frontend/dist/browser /app/static/browser

ENV FLASK_ENV=production
ENV PYTHONUNBUFFERED=1
ENV FRONTEND_BUILD_DIR=/app/static/browser
ENV PORT=8080

EXPOSE 8080

CMD exec gunicorn \
    --bind 0.0.0.0:$PORT \
    --worker-class eventlet \
    --workers 1 \
    --timeout 300 \
    --keep-alive 65 \
    app:app

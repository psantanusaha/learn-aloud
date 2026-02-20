# LearnAloud Deployment Guide

## Overview
This application uses environment-based configuration to support both local development and production deployment from a single codebase.

## Two Modes

### 1. Local Development (Default)
**When to use**: Testing, debugging, development work
- Runs with Flask debug mode
- CORS allows all origins (`*`)
- No static file serving (frontend runs separately via Angular dev server)
- No API key restrictions

**How to run locally**:
```bash
# Backend
cd backend
pip install -r requirements.txt
python app.py
# Runs on http://localhost:5000

# Frontend (separate terminal)
cd learnaloud-frontend
npm install
npm start
# Runs on http://localhost:4200
```

### 2. Production Deployment
**When to use**: Public access, live deployment
- Static file serving enabled (Flask serves Angular build)
- Restricted CORS (configure via ALLOWED_ORIGINS env var)
- Optimized for performance

**How to deploy**:
1. Build the frontend:
```bash
cd learnaloud-frontend
npm install
npm run build
# Output: dist/browser/
```

2. Deploy backend (example for Heroku):
```bash
cd backend
heroku create your-app-name
heroku buildpacks:set heroku/python
git push heroku main
```

3. Set environment variables on production server:
```
FLASK_ENV=production
ALLOWED_ORIGINS=https://your-domain.com
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| FLASK_ENV | development | Set to "production" for deployment |
| FLASK_DEBUG | 1 | Set to 0 in production |
| ALLOWED_ORIGINS | * | Comma-separated list of allowed origins (production) |

## Files Changed

- `backend/app.py` - Added environment detection and conditional production routes
- `backend/Procfile` - Updated for production with FLASK_ENV=production
- `backend/.env.example` - Template for local development
- `learnaloud-frontend/angular.json` - Added explicit outputPath for production builds

#!/bin/bash

# Exit on error
set -e

# Backend setup
echo "Setting up backend..."
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
deactivate
cd ..

# Frontend setup
echo "Setting up frontend..."
cd learnaloud-frontend
npm install
cd ..

# ArXiv MCP setup
echo "Setting up ArXiv MCP server..."
cd arxiv-mcp
uv venv
source .venv/bin/activate
uv pip install -e .
deactivate
cd ..

echo "Setup complete!"

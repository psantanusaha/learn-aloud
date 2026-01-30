# LearnAloud - Voice-Synchronized PDF Teaching Assistant

A proof-of-concept application demonstrating synchronized voice teaching with PDF annotations. An AI tutor highlights text in a PDF in real-time, simulating voice-synchronized visual teaching.

## Prerequisites

Before you begin, ensure you have the following installed:

- [Python](https://www.python.org/downloads/) (version 3.10 or higher)
- [Node.js](https://nodejs.org/en/download/) (version 18 or higher)
- [uv](https://github.com/astral-sh/uv) (for the ArXiv MCP server)

## Getting Started

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/psantanusaha/learn-aloud.git
    cd learn-aloud
    ```

2.  **Set up environment variables:**

    *   **Backend:** Create a `.env` file in the `backend` directory and add the following:

        ```
        VOCAL_BRIDGE_API_KEY=<your-vocal-bridge-api-key>
        ```

    *   **ArXiv MCP:** Create a `.env` file in the `arxiv-mcp` directory:

        ```
        TRANSPORT=sse
        HOST=0.0.0.0
        PORT=8050
        ```

## Easy Installation

You can use the `setup.sh` script to install all the dependencies for the backend, frontend, and ArXiv MCP server.

```bash
chmod +x setup.sh
./setup.sh
```

## Manual Installation

If you prefer to install the dependencies manually, follow the instructions below.

### Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate  # On Windows, use `venv\Scripts\activate`
pip install -r requirements.txt
```

### Frontend

```bash
cd learnaloud-frontend
npm install
```

### ArXiv MCP Server

```bash
cd arxiv-mcp
uv venv
source .venv/bin/activate # On Windows, use `.venv\Scripts\activate`
uv pip install -e .
```

## Running the Application

You will need to run three servers in separate terminals.

### Terminal 1 - Backend

```bash
cd backend
source venv/bin/activate  # On Windows, use `venv\Scripts\activate`
python app.py
```

The backend server will be running on `http://localhost:5000`.

### Terminal 2 - Frontend

```bash
cd learnaloud-frontend
npx ng serve
```

The frontend development server will be running on `http://localhost:4200`.

### Terminal 3 - ArXiv MCP Server

```bash
cd arxiv-mcp
source .venv/bin/activate # On Windows, use `.venv\Scripts\activate`
python src/server.py
```

The ArXiv MCP server will be running on `http://localhost:8050`.

### Open the app

Navigate to [http://localhost:4200](http://localhost:4200) in your browser.

## Development

### Testing

*   **Backend:**

    ```bash
    cd backend
    pytest
    ```

*   **Frontend:**

    ```bash
    cd learnaloud-frontend
    npx ng test
    ```

### Linting and Formatting

*   **Backend:**

    ```bash
    cd backend
    # Add your preferred linting and formatting commands here
    ```

*   **Frontend:**

    ```bash
    cd learnaloud-frontend
    npx ng lint
    ```

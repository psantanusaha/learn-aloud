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
    git clone <repository-url>
    cd learn-aloud
    ```

2.  **Set up environment variables:**

    *   **Backend:** Create a `.env` file in the `backend` directory and add the following:

        ```
        VOCAL_BRIDGE_API_KEY=<your-vocal-bridge-api-key>
        ```

    *   **ArXiv MCP:** Create a `.env` file in the `arxiv-mcp` directory and add any necessary environment variables (refer to `arxiv-mcp/.env.example`).

## Easy Installation

You can use the `setup.sh` script to install all the dependencies for the backend, frontend, and ArXiv MCP server.

```bash
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

## Deployment

This project can be deployed to a variety of platforms. Here are some recommendations for a quick and easy setup.

### Frontend (Vercel)

1.  **Sign up for Vercel:** Create an account at [vercel.com](https://vercel.com) and connect your GitHub account.
2.  **Create a new project:** From the Vercel dashboard, click "New Project" and import your GitHub repository.
3.  **Configure the project:** Vercel will automatically detect that you have an Angular application and configure the build settings. You will need to set the "Root Directory" to `learnaloud-frontend`.
4.  **Deploy:** Click "Deploy" and Vercel will build and deploy your frontend.

### Backend and ArXiv MCP Server (Heroku)

You will need to create two separate applications on Heroku, one for the backend and one for the ArXiv MCP server.

**For each application:**

1.  **Sign up for Heroku:** Create an account at [heroku.com](https://www.heroku.com/).
2.  **Create a new app:** From the Heroku dashboard, click "New" and then "Create new app".
3.  **Connect to GitHub:** In the "Deploy" tab of your new Heroku app, connect your GitHub account and select your repository.
4.  **Configure the app:**
    *   **Backend:** In the "Settings" tab, set the "Buildpack" to `heroku/python`.
    *   **ArXiv MCP Server:** In the "Settings" tab, set the "Buildpack" to `heroku/python`.
    *   **For both apps:** You will need to set the `VOCAL_BRIDGE_API_KEY` and any other necessary environment variables in the "Config Vars" section of the "Settings" tab.
5.  **Enable automatic deploys:** In the "Deploy" tab, you can enable automatic deploys from your `main` branch.

**Important:** Since you are deploying two separate applications from the same repository, you will need to tell Heroku which directory to use for each application. You can do this by setting the `PROJECT_PATH` config var in the "Settings" tab.

*   **For the backend app:** Set `PROJECT_PATH` to `backend`.
*   **For the ArXiv MCP server app:** Set `PROJECT_PATH` to `arxiv-mcp`.

This is a simplified guide. For more detailed instructions, please refer to the official documentation for [Vercel](https://vercel.com/docs) and [Heroku](https://devcenter.heroku.com/categories/deployment).

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

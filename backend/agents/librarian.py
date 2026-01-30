import asyncio
import json
import os
import time
import uuid
import xml.etree.ElementTree as ET

import requests

try:
    from mcp.client.sse import sse_client
    from mcp import ClientSession
    _MCP_AVAILABLE = True
except ImportError:
    _MCP_AVAILABLE = False


class Librarian:
    """ArXiv search agent — uses the ArXiv public API for search and download.
    MCP is optional and only used as a fallback if available."""

    ARXIV_API_URL = "http://export.arxiv.org/api/query"

    def __init__(self, upload_dir, pdf_processor, mcp_url="http://localhost:8050/sse"):
        self.upload_dir = upload_dir
        self.pdf_processor = pdf_processor
        self.mcp_url = mcp_url

    # ------------------------------------------------------------------
    # MCP helpers
    # ------------------------------------------------------------------

    async def _call_tool(self, tool_name, arguments):
        """Connect to the ArXiv MCP server and call a tool."""
        async with sse_client(self.mcp_url) as streams:
            async with ClientSession(*streams) as session:
                await session.initialize()
                result = await session.call_tool(tool_name, arguments)
                return result

    def _run_async(self, coro):
        """Run an async coroutine from sync code."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            # We're inside an existing event loop (e.g. Flask with async);
            # run in a new thread to avoid blocking
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                return pool.submit(asyncio.run, coro).result()
        else:
            return asyncio.run(coro)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def search(self, query, max_results=5):
        """Search ArXiv using the public API (no MCP dependency).

        Returns a tuple of (papers_list, api_info_dict).
        """
        start = time.time()
        params = {
            "search_query": f"all:{query}",
            "start": 0,
            "max_results": max_results,
            "sortBy": "relevance",
            "sortOrder": "descending",
        }
        resp = requests.get(self.ARXIV_API_URL, params=params, timeout=15)
        resp.raise_for_status()
        duration_ms = round((time.time() - start) * 1000)

        papers = self._parse_arxiv_response(resp.text)

        api_info = {
            "server": "arxiv-api",
            "tool": "search_arxiv",
            "arguments": {"query": query, "limit": max_results},
            "duration_ms": duration_ms,
        }

        return papers, api_info

    def _parse_arxiv_response(self, xml_text):
        """Parse ArXiv Atom XML response into a list of paper dicts."""
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        root = ET.fromstring(xml_text)
        papers = []

        for entry in root.findall("atom:entry", ns):
            title_el = entry.find("atom:title", ns)
            summary_el = entry.find("atom:summary", ns)
            published_el = entry.find("atom:published", ns)

            title = (title_el.text or "").strip().replace("\n", " ") if title_el is not None else ""
            summary_raw = (summary_el.text or "").strip().replace("\n", " ") if summary_el is not None else ""
            summary = summary_raw[:300] + ("..." if len(summary_raw) > 300 else "")
            published = (published_el.text or "")[:10] if published_el is not None else ""

            authors = []
            for author in entry.findall("atom:author", ns)[:3]:
                name_el = author.find("atom:name", ns)
                if name_el is not None and name_el.text:
                    authors.append(name_el.text.strip())

            # Extract arxiv_id from the entry id URL
            id_el = entry.find("atom:id", ns)
            arxiv_url = (id_el.text or "") if id_el is not None else ""
            arxiv_id = arxiv_url.split("/abs/")[-1] if "/abs/" in arxiv_url else arxiv_url

            # Find PDF link
            pdf_url = ""
            for link in entry.findall("atom:link", ns):
                if link.get("title") == "pdf":
                    pdf_url = link.get("href", "")
                    break

            papers.append({
                "arxiv_id": arxiv_id,
                "title": title,
                "summary": summary,
                "authors": authors,
                "published": published,
                "pdf_url": pdf_url or f"https://arxiv.org/pdf/{arxiv_id}.pdf",
            })

        return papers

    def list_tools(self):
        """Return available tools. Uses MCP if available, otherwise returns built-in list."""
        if not _MCP_AVAILABLE:
            return [
                {"name": "search_arxiv", "description": "Search ArXiv papers (direct API)"},
                {"name": "download_paper", "description": "Download paper PDF from ArXiv"},
            ]
        try:
            async def _list():
                async with sse_client(self.mcp_url) as streams:
                    async with ClientSession(*streams) as session:
                        await session.initialize()
                        result = await session.list_tools()
                        return result.tools

            tools_raw = self._run_async(_list())
            tools = []
            for t in tools_raw:
                tools.append({
                    "name": t.name,
                    "description": getattr(t, "description", "") or "",
                })
            return tools
        except Exception:
            return [
                {"name": "search_arxiv", "description": "Search ArXiv papers (direct API)"},
                {"name": "download_paper", "description": "Download paper PDF from ArXiv"},
            ]

    def get_paper_details(self, arxiv_id, include_content=False):
        """Get detailed info about a paper. Uses direct ArXiv API."""
        params = {
            "id_list": arxiv_id,
            "max_results": 1,
        }
        resp = requests.get(self.ARXIV_API_URL, params=params, timeout=15)
        resp.raise_for_status()

        papers = self._parse_arxiv_response(resp.text)
        if not papers:
            return f"Paper {arxiv_id} not found on ArXiv."

        p = papers[0]
        lines = [
            f"# {p['title']}",
            f"**Authors:** {', '.join(p['authors'])}",
            f"**Published:** {p['published']}",
            f"**ArXiv ID:** {p['arxiv_id']}",
            "",
            f"**Abstract:** {p['summary']}",
        ]
        return "\n".join(lines)

    def download_paper(self, arxiv_id):
        """Download a paper PDF from ArXiv and process it.

        Returns a dict with session_id, filename, total_pages, filepath,
        and pdf_data suitable for registering in the sessions store.
        """
        pdf_url = f"https://arxiv.org/pdf/{arxiv_id}.pdf"
        resp = requests.get(pdf_url, timeout=30)
        resp.raise_for_status()

        session_id = str(uuid.uuid4())
        filename = f"{session_id}.pdf"
        filepath = os.path.join(self.upload_dir, filename)

        with open(filepath, "wb") as f:
            f.write(resp.content)

        pdf_data = self.pdf_processor.extract_structure(filepath)

        return {
            "session_id": session_id,
            "filename": f"arxiv-{arxiv_id}.pdf",
            "total_pages": pdf_data["total_pages"],
            "filepath": filepath,
            "pdf_data": pdf_data,
        }

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface ArxivPaper {
  arxiv_id: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  pdf_url: string;
}

export interface McpInfo {
  server: string;
  tool: string;
  arguments: Record<string, any>;
  duration_ms: number;
}

export interface McpTool {
  name: string;
  description: string;
}

export interface McpToolsResponse {
  tools: McpTool[];
  server: string;
  status: string;
}

export interface ArxivSearchResult {
  papers: ArxivPaper[];
  query: string;
  mcp_info?: McpInfo;
}

export interface CitationResult {
  found: boolean;
  number?: number;
  text?: string;
  page?: number;
  bbox?: number[];
  reference?: string;
}

export interface ReferenceList {
  references: CitationResult[];
  count: number;
}

export interface DownloadResult {
  session_id: string;
  filename: string;
  total_pages: number;
}

@Injectable({ providedIn: 'root' })
export class AgentService {
  private readonly baseUrl = '/api/agents';

  constructor(private http: HttpClient) {}

  searchArxiv(query: string, maxResults = 5): Observable<ArxivSearchResult> {
    return this.http.post<ArxivSearchResult>(`${this.baseUrl}/librarian/search`, {
      query,
      max_results: maxResults,
    });
  }

  downloadPaper(arxivId: string): Observable<DownloadResult> {
    return this.http.post<DownloadResult>(`${this.baseUrl}/librarian/download`, {
      arxiv_id: arxivId,
    });
  }

  findCitation(sessionId: string, reference: string): Observable<CitationResult> {
    return this.http.post<CitationResult>(`${this.baseUrl}/navigator/find-citation`, {
      session_id: sessionId,
      reference,
    });
  }

  listReferences(sessionId: string): Observable<ReferenceList> {
    return this.http.get<ReferenceList>(`${this.baseUrl}/navigator/references`, {
      params: { session_id: sessionId },
    });
  }

  getMcpTools(): Observable<McpToolsResponse> {
    return this.http.get<McpToolsResponse>(`${this.baseUrl}/mcp/tools`);
  }
}

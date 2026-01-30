import { Component, Input, Output, EventEmitter } from '@angular/core';
import { ArxivPaper, CitationResult, McpInfo } from '../../services/agent.service';

export type AgentResult =
  | { type: 'arxiv_search'; query: string; papers: ArxivPaper[]; mcp_info?: McpInfo }
  | { type: 'citation'; result: CitationResult };

@Component({
  selector: 'app-agent-results-panel',
  standalone: true,
  templateUrl: './agent-results-panel.component.html',
  styleUrls: ['./agent-results-panel.component.css'],
})
export class AgentResultsPanelComponent {
  @Input() results: AgentResult[] = [];
  @Input() isLoading = false;
  @Output() downloadPaper = new EventEmitter<string>();

  expandedMcpIndex: number | null = null;

  onDownload(arxivId: string): void {
    this.downloadPaper.emit(arxivId);
  }

  toggleMcpDetail(index: number): void {
    this.expandedMcpIndex = this.expandedMcpIndex === index ? null : index;
  }

  formatDuration(ms: number): string {
    return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
  }

  formatArgs(args: Record<string, any>): string {
    return JSON.stringify(args);
  }

  cleanLatex(text: string): string {
    if (!text) return text;
    return text
      .replace(/\$([^$]*)\$/g, '$1')          // strip $ delimiters
      .replace(/\\(rightarrow|leftarrow|Rightarrow|Leftarrow)/g, '→')
      .replace(/\\(times|cdot)/g, '·')
      .replace(/\\(alpha|beta|gamma|delta|epsilon|theta|lambda|mu|sigma|pi|phi|psi|omega)/gi,
        (_, l) => ({ alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ε',theta:'θ',lambda:'λ',mu:'μ',sigma:'σ',pi:'π',phi:'φ',psi:'ψ',omega:'ω' } as any)[l.toLowerCase()] || l)
      .replace(/\\text\{([^}]*)\}/g, '$1')
      .replace(/\\mathrm\{([^}]*)\}/g, '$1')
      .replace(/\\mathbb\{([^}]*)\}/g, '$1')
      .replace(/\\[a-zA-Z]+/g, '')            // strip remaining commands
      .replace(/[{}]/g, '')                    // strip braces
      .replace(/\^(\w)/g, '$1')               // strip superscript marker
      .replace(/_(\w)/g, '$1')                // strip subscript marker
      .replace(/\s{2,}/g, ' ')               // collapse spaces
      .trim();
  }
}

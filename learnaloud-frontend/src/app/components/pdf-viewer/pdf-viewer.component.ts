import {
  Component,
  Input,
  Output,
  EventEmitter,
  ElementRef,
  ViewChild,
  OnChanges,
  SimpleChanges,
  AfterViewInit,
  ChangeDetectorRef,
  OnInit,
} from '@angular/core';
import * as pdfjsLib from 'pdfjs-dist';
import { ActionService } from '../../services/action.service'; // Added
import { Action, HighlightTextPayload, HighlightRegionPayload, NavigateToPagePayload } from '../../actions';

// Configure PDF.js worker.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

@Component({
  selector: 'app-pdf-viewer',
  standalone: true,
  templateUrl: './pdf-viewer.component.html',
  styleUrls: ['./pdf-viewer.component.css'],
})
export class PdfViewerComponent implements AfterViewInit, OnChanges, OnInit {
  @Input() pdfUrl: string = '';
  @Input() sessionId: string = '';
  @Input() isPreview: boolean = false;
  @Output() pageChanged = new EventEmitter<{ page: number; totalPages: number }>();

  @ViewChild('pdfCanvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('textLayer', { static: false }) textLayerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('canvasContainer', { static: false }) containerRef!: ElementRef<HTMLDivElement>;

  currentPage = 1;
  totalPages = 0;
  private pdfDoc: any = null;
  private scale = 1.5;
  private pdfLoaded = false;
  private activeHighlights: { type: 'text' | 'region'; payload: any }[] = [];

  constructor(private cdr: ChangeDetectorRef, private actionService: ActionService) {}

  ngOnInit(): void {
    this.actionService.action$.subscribe(action => {
      if (action.type === 'HIGHLIGHT_TEXT') {
        const payload = action.payload as HighlightTextPayload;
        if (!this.shouldHandleAction(payload.sessionId)) return;
        this.activeHighlights.push({ type: 'text', payload });
        this.highlightWithPageSearch(payload);
      } else if (action.type === 'HIGHLIGHT_REGION') {
        const payload = action.payload as HighlightRegionPayload;
        if (!this.shouldHandleAction(payload.sessionId)) return;
        this.activeHighlights.push({ type: 'region', payload });
        if (payload.page && payload.page !== this.currentPage) {
          this.currentPage = payload.page;
          this.renderPage(this.currentPage).then(() => this.applyHighlights());
        } else {
          this.highlightRegion(payload);
        }
      } else if (action.type === 'NAVIGATE_TO_PAGE') {
        const payload = action.payload as NavigateToPagePayload;
        if (!this.shouldHandleAction(payload.sessionId)) return;
        const targetPage = payload.page;
        if (targetPage >= 1 && targetPage <= this.totalPages && targetPage !== this.currentPage) {
          this.currentPage = targetPage;
          this.activeHighlights = [];
          this.renderPage(this.currentPage);
          this.pageChanged.emit({ page: this.currentPage, totalPages: this.totalPages });
        }
      }
    });
  }

  private shouldHandleAction(payloadSessionId?: string): boolean {
    // If no sessionId on payload, handle only if this is not a preview viewer
    if (!payloadSessionId) return !this.isPreview;
    // If sessionId on payload, handle only if it matches this viewer's sessionId
    return payloadSessionId === this.sessionId;
  }

  private async highlightWithPageSearch(payload: HighlightTextPayload): Promise<void> {
    // First, try the specified page
    if (payload.page && payload.page !== this.currentPage) {
      this.currentPage = payload.page;
      await this.renderPage(this.currentPage);
      await this.waitForTextLayer();
    }

    if (this.highlightText(payload.text, payload.color)) return;

    // Text not found on specified page — search all pages
    if (!this.pdfDoc) return;
    console.log(`Searching all pages for "${payload.text.substring(0, 40)}..."`);

    for (let p = 1; p <= this.totalPages; p++) {
      if (p === this.currentPage) continue;
      const found = await this.textExistsOnPage(payload.text, p);
      if (found) {
        console.log(`Found on page ${p}`);
        payload.page = p;
        this.currentPage = p;
        await this.renderPage(p);
        await this.waitForTextLayer();
        this.highlightText(payload.text, payload.color);
        return;
      }
    }
    console.warn(`Text "${payload.text}" not found on any page`);
  }

  private waitForTextLayer(): Promise<void> {
    return new Promise(resolve => {
      requestAnimationFrame(() => setTimeout(resolve, 50));
    });
  }

  private async textExistsOnPage(searchText: string, pageNum: number): Promise<boolean> {
    if (!this.pdfDoc) return false;
    const page = await this.pdfDoc.getPage(pageNum);
    const content = await page.getTextContent();
    const fullText = content.items.map((item: any) => item.str).join(' ');
    const normalized = this.normalizeForSearch(fullText);
    const searchNorm = this.normalizeForSearch(searchText);

    if (normalized.includes(searchNorm)) return true;

    // Try keyword fallback — require at least 2 words and 10 chars
    const words = searchNorm.split(/\s+/).filter((w: string) => w.length >= 3);
    for (let len = words.length; len >= 2; len--) {
      for (let start = 0; start <= words.length - len; start++) {
        const phrase = words.slice(start, start + len).join(' ');
        if (phrase.length >= 10 && normalized.includes(phrase)) return true;
      }
    }
    return false;
  }

  ngAfterViewInit(): void {
    if (this.pdfUrl) {
      this.loadPdf();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['pdfUrl'] && this.pdfUrl && this.canvasRef) {
      this.loadPdf();
    }
  }

  // ---------- PDF loading & rendering ----------------------------------------

  private async loadPdf(): Promise<void> {
    try {
      console.log('Loading PDF from:', this.pdfUrl);
      const loadingTask = pdfjsLib.getDocument(this.pdfUrl);
      this.pdfDoc = await loadingTask.promise;
      this.totalPages = this.pdfDoc.numPages;
      this.currentPage = 1;
      this.pdfLoaded = true;
      console.log('PDF loaded, pages:', this.totalPages);
      await this.renderPage(this.currentPage);
      this.pageChanged.emit({ page: this.currentPage, totalPages: this.totalPages });
      this.cdr.detectChanges();
    } catch (err) {
      console.error('Failed to load PDF:', err);
    }
  }

  private computeScale(page: any): number {
    // Only adjust scale on mobile-sized screens
    if (window.innerWidth > 768) {
      return this.scale;
    }
    const container = this.containerRef?.nativeElement;
    if (container) {
      const containerWidth = container.clientWidth - 8; // account for padding
      const defaultViewport = page.getViewport({ scale: 1 });
      return containerWidth / defaultViewport.width;
    }
    return this.scale;
  }

  private async renderPage(pageNum: number): Promise<void> {
    if (!this.pdfDoc) return;

    const page = await this.pdfDoc.getPage(pageNum);
    const effectiveScale = this.computeScale(page);
    const viewport = page.getViewport({ scale: effectiveScale });

    // Canvas
    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d')!;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Text layer
    const textContent = await page.getTextContent();
    const textLayerDiv = this.textLayerRef.nativeElement;
    textLayerDiv.innerHTML = '';
    textLayerDiv.style.width = `${viewport.width}px`;
    textLayerDiv.style.height = `${viewport.height}px`;

    for (const item of textContent.items as any[]) {
      if (!item.str) continue;

      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.position = 'absolute';
      span.style.left = `${tx[4]}px`;
      span.style.top = `${tx[5] - item.height * effectiveScale}px`;
      span.style.fontSize = `${item.height * effectiveScale}px`;
      span.style.fontFamily = item.fontName || 'sans-serif';
      span.style.whiteSpace = 'pre';
      span.style.color = 'transparent';
      span.style.lineHeight = '1';
      span.dataset['text'] = item.str;

      textLayerDiv.appendChild(span);
    }
  }

  // ---------- Highlighting ---------------------------------------------------

  private normalizeQuotes(text: string): string {
    return text
      .replace(/[\u2018\u2019\u0060\u00B4]/g, "'")
      .replace(/[\u201C\u201D\u00AB\u00BB]/g, '"')
      .replace(/[\u2013\u2014]/g, '-');
  }

  private normalizeForSearch(text: string): string {
    return this.normalizeQuotes(text.toLowerCase())
      // Strip math formatting: ^, _, {, }, LaTeX-style
      .replace(/[\^_{}\\]/g, '')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }

  highlightText(searchText: string, color: string): boolean {
    const textLayerDiv = this.textLayerRef?.nativeElement;
    if (!textLayerDiv) return false;

    const spans = textLayerDiv.querySelectorAll('span') as NodeListOf<HTMLSpanElement>;

    // Build a map of character positions to spans
    let fullText = '';
    const spanMap: { span: HTMLSpanElement; start: number; end: number }[] = [];

    spans.forEach((span) => {
      const text = span.dataset['text'] || span.textContent || '';
      const start = fullText.length;
      fullText += text + ' ';
      spanMap.push({ span, start, end: start + text.length });
    });

    const normalizedFull = this.normalizeForSearch(fullText);
    const normalizedSearch = this.normalizeForSearch(searchText);

    let idx = normalizedFull.indexOf(normalizedSearch);

    // Fallback: try subphrases but require at least 2 words to avoid matching random single words
    let matchLen = normalizedSearch.length;
    if (idx === -1) {
      const words = normalizedSearch.split(/\s+/).filter(w => w.length >= 3);
      for (let len = words.length; len >= 2 && idx === -1; len--) {
        for (let start = 0; start <= words.length - len && idx === -1; start++) {
          const phrase = words.slice(start, start + len).join(' ');
          if (phrase.length >= 10) {
            idx = normalizedFull.indexOf(phrase);
            if (idx !== -1) {
              matchLen = phrase.length;
              console.log(`Fuzzy highlight matched: "${phrase}"`);
            }
          }
        }
      }
    }

    if (idx === -1) {
      console.warn(`Text "${searchText}" not found in current page (even with fuzzy match)`);
      return false;
    }

    // Map normalized index back to original text positions
    // Since normalization can shift indices, find the spans that overlap
    // We re-scan the original fullText to find the matching region
    const origLower = this.normalizeForSearch(fullText);
    const matchEnd = idx + matchLen;
    let firstMatch: HTMLSpanElement | null = null;

    for (const entry of spanMap) {
      const entryStartNorm = this.normalizeForSearch(fullText.substring(0, entry.start)).length;
      const entryEndNorm = this.normalizeForSearch(fullText.substring(0, entry.end)).length;
      if (entryEndNorm > idx && entryStartNorm < matchEnd) {
        const rgba = this.colorToRgba(color);
        entry.span.style.backgroundColor = rgba;
        entry.span.style.color = 'transparent';
        entry.span.style.transition = 'background-color 0.5s ease-in-out';
        entry.span.style.borderRadius = '3px';
        if (!firstMatch) firstMatch = entry.span;
      }
    }

    if (firstMatch) {
      firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return !!firstMatch;
  }

  private colorToRgba(color: string): string {
    const map: Record<string, string> = {
      yellow: 'rgba(255, 235, 59, 0.4)',
      green: 'rgba(76, 175, 80, 0.4)',
      blue: 'rgba(33, 150, 243, 0.4)',
      pink: 'rgba(233, 30, 99, 0.4)',
    };
    return map[color] || 'rgba(255, 235, 59, 0.4)';
  }

  private async highlightRegion(payload: HighlightRegionPayload): Promise<void> {
    if (!this.pdfDoc || !this.canvasRef) return;

    // Ensure we are on the correct page before highlighting
    if (payload.page !== this.currentPage) {
      this.currentPage = payload.page;
      await this.renderPage(this.currentPage);
    }

    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d')!;

    // Get the viewport for the current page to calculate scaling
    const page = await this.pdfDoc.getPage(this.currentPage);
    const viewport = page.getViewport({ scale: this.scale });

    // Payload coordinates are in PDF units (72 DPI). Scale to canvas pixels.
    const x = payload.x * this.scale;
    const y = payload.y * this.scale;
    const w = payload.w * this.scale;
    const h = payload.h * this.scale;

    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = payload.color;
    ctx.fillRect(x, y, w, h);
    // Draw a visible border around the region
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = payload.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();

    // Scroll the highlighted region into view
    const container = this.containerRef?.nativeElement;
    if (container) {
      const canvasTop = this.canvasRef.nativeElement.offsetTop;
      container.scrollTo({ top: canvasTop + y - 20, behavior: 'smooth' });
    }
  }

  // ---------- Highlight management -------------------------------------------

  private applyHighlights(): void {
    for (const h of this.activeHighlights) {
      if (h.type === 'text') {
        const p = h.payload as HighlightTextPayload;
        if (p.page === this.currentPage) {
          this.highlightText(p.text, p.color);
        }
      } else {
        const p = h.payload as HighlightRegionPayload;
        if (p.page === this.currentPage) {
          this.highlightRegion(p);
        }
      }
    }
  }

  // ---------- Navigation -----------------------------------------------------

  previousPage(): void {
    if (this.currentPage > 1) {
      this.currentPage--;
      this.activeHighlights = [];
      this.renderPage(this.currentPage);
      this.pageChanged.emit({ page: this.currentPage, totalPages: this.totalPages });
    }
  }

  nextPage(): void {
    if (this.currentPage < this.totalPages) {
      this.currentPage++;
      this.activeHighlights = [];
      this.renderPage(this.currentPage);
      this.pageChanged.emit({ page: this.currentPage, totalPages: this.totalPages });
    }
  }
}

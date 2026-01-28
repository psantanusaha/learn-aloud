import {
  Component,
  Input,
  ElementRef,
  ViewChild,
  OnChanges,
  SimpleChanges,
  AfterViewInit,
  ChangeDetectorRef,
} from '@angular/core';
import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

interface HighlightCommand {
  text: string;
  color: string;
  page: number;
}

@Component({
  selector: 'app-pdf-viewer',
  standalone: true,
  templateUrl: './pdf-viewer.component.html',
  styleUrls: ['./pdf-viewer.component.css'],
})
export class PdfViewerComponent implements AfterViewInit, OnChanges {
  @Input() pdfUrl: string = '';
  @Input() highlightCommands: HighlightCommand[] = [];

  @ViewChild('pdfCanvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('textLayer', { static: false }) textLayerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('canvasContainer', { static: false }) containerRef!: ElementRef<HTMLDivElement>;

  currentPage = 1;
  totalPages = 0;
  private pdfDoc: any = null;
  private scale = 1.5;
  private lastHighlightCount = 0;
  private pdfLoaded = false;

  constructor(private cdr: ChangeDetectorRef) {}

  ngAfterViewInit(): void {
    if (this.pdfUrl) {
      this.loadPdf();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['pdfUrl'] && this.pdfUrl && this.canvasRef) {
      this.loadPdf();
    }
    if (changes['highlightCommands'] && this.pdfLoaded) {
      this.processNewHighlights();
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
      this.cdr.detectChanges();
    } catch (err) {
      console.error('Failed to load PDF:', err);
    }
  }

  private async renderPage(pageNum: number): Promise<void> {
    if (!this.pdfDoc) return;

    const page = await this.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: this.scale });

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
      span.style.top = `${tx[5] - item.height * this.scale}px`;
      span.style.fontSize = `${item.height * this.scale}px`;
      span.style.fontFamily = item.fontName || 'sans-serif';
      span.style.whiteSpace = 'pre';
      span.style.color = 'transparent';
      span.style.lineHeight = '1';
      span.dataset['text'] = item.str;

      textLayerDiv.appendChild(span);
    }
  }

  // ---------- Highlighting ---------------------------------------------------

  private processNewHighlights(): void {
    if (this.highlightCommands.length <= this.lastHighlightCount) return;

    const newCommands = this.highlightCommands.slice(this.lastHighlightCount);
    this.lastHighlightCount = this.highlightCommands.length;

    for (const cmd of newCommands) {
      if (cmd.page !== this.currentPage) {
        this.currentPage = cmd.page;
        this.renderPage(this.currentPage).then(() => {
          this.highlightText(cmd.text, cmd.color);
        });
      } else {
        this.highlightText(cmd.text, cmd.color);
      }
    }
  }

  highlightText(searchText: string, color: string): void {
    const textLayerDiv = this.textLayerRef?.nativeElement;
    if (!textLayerDiv) return;

    const spans = textLayerDiv.querySelectorAll('span') as NodeListOf<HTMLSpanElement>;
    const searchLower = searchText.toLowerCase();

    // Build a map of character positions to spans
    let fullText = '';
    const spanMap: { span: HTMLSpanElement; start: number; end: number }[] = [];

    spans.forEach((span) => {
      const text = span.dataset['text'] || span.textContent || '';
      const start = fullText.length;
      fullText += text + ' ';
      spanMap.push({ span, start, end: start + text.length });
    });

    const idx = fullText.toLowerCase().indexOf(searchLower);
    if (idx === -1) {
      console.warn(`Text "${searchText}" not found in current page`);
      return;
    }

    const matchEnd = idx + searchText.length;
    let firstMatch: HTMLSpanElement | null = null;

    for (const entry of spanMap) {
      if (entry.end > idx && entry.start < matchEnd) {
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

  // ---------- Navigation -----------------------------------------------------

  previousPage(): void {
    if (this.currentPage > 1) {
      this.currentPage--;
      this.renderPage(this.currentPage);
    }
  }

  nextPage(): void {
    if (this.currentPage < this.totalPages) {
      this.currentPage++;
      this.renderPage(this.currentPage);
    }
  }
}

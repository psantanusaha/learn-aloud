import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { PdfViewerComponent } from './components/pdf-viewer/pdf-viewer.component';
import { ApiService } from './services/api.service';

interface HighlightCommand {
  text: string;
  color: string;
  page: number;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [PdfViewerComponent],
  templateUrl: './app.html',
  styleUrls: ['./app.css'],
})
export class App implements OnInit, OnDestroy {
  sessionId = '';
  pdfUrl = '';
  highlightCommands: HighlightCommand[] = [];
  isDemoRunning = false;
  uploadedFileName = '';
  statusMessage = '';

  constructor(private api: ApiService, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    this.api.connectSocket();

    this.api.onConnect(() => {
      console.log('Connected to LearnAloud server');
      this.statusMessage = 'Connected to server';
      this.cdr.detectChanges();
    });

    this.api.onDemoStarted(() => {
      this.isDemoRunning = true;
      this.statusMessage = 'Demo running - watch the PDF for highlights...';
      this.cdr.detectChanges();
    });

    this.api.onClientAction((action: any) => {
      console.log('Received action:', action);
      this.handleClientAction(action);
      this.cdr.detectChanges();
    });

    this.api.onDemoFinished(() => {
      this.isDemoRunning = false;
      this.statusMessage = 'Demo completed!';
      this.cdr.detectChanges();
    });
  }

  ngOnDestroy(): void {
    this.api.disconnectSocket();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;

    const file = input.files[0];
    this.statusMessage = 'Uploading PDF...';

    this.api.uploadPDF(file).subscribe({
      next: (res: any) => {
        this.sessionId = res.session_id;
        this.pdfUrl = this.api.getPdfUrl(res.session_id);
        this.uploadedFileName = res.filename;
        this.highlightCommands = [];
        this.statusMessage = `Loaded "${res.filename}" (${res.total_pages} pages)`;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Upload failed:', err);
        this.statusMessage = 'Upload failed. Please try again.';
        this.cdr.detectChanges();
      },
    });
  }

  startDemo(): void {
    if (!this.sessionId) return;
    this.highlightCommands = [];
    this.api.startDemo(this.sessionId);
  }

  private handleClientAction(action: any): void {
    if (action.type === 'highlight_text') {
      const { text, color, page } = action.payload;
      this.highlightCommands = [
        ...this.highlightCommands,
        { text, color: color || 'yellow', page: page || 1 },
      ];
    }
  }
}

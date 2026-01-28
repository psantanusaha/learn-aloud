import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { PdfViewerComponent } from './components/pdf-viewer/pdf-viewer.component';
import { ApiService } from './services/api.service';
import { VoiceService, TranscriptEntry } from './services/voice.service';

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

  voiceError = '';

  transcriptEntries: TranscriptEntry[] = [];

  get isVoiceConnected() { return this.voice.isConnected; }
  get isVoiceConnecting() { return this.voice.isConnecting; }
  get isMicMuted() { return !this.voice.isMicEnabled; }

  constructor(
    private api: ApiService,
    private voice: VoiceService,
    private cdr: ChangeDetectorRef,
  ) {}

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

    this.voice.setClientActionHandler((action: any) => {
      console.log('Voice action:', action);
      this.handleClientAction(action);
      this.cdr.detectChanges();
    });

    this.voice.setTranscriptHandler((entries: TranscriptEntry[]) => {
      this.transcriptEntries = [...entries];
      this.cdr.detectChanges();
    });
  }

  ngOnDestroy(): void {
    this.api.disconnectSocket();
    this.voice.disconnect();
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

  async startVoiceSession(): Promise<void> {
    if (!this.sessionId) return;
    this.voiceError = '';
    this.cdr.detectChanges();

    this.api.getVoiceToken('student', this.sessionId).subscribe({
      next: async (res: any) => {
        try {
          await this.voice.connect(res.livekit_url, res.token);
          this.statusMessage = 'Voice session active';
          this.cdr.detectChanges();
        } catch (e: any) {
          this.voiceError = `Failed to connect: ${e.message || e}`;
          this.cdr.detectChanges();
        }
      },
      error: (err) => {
        const msg = err.error?.error || err.message || 'Unknown error';
        this.voiceError = `Voice token error: ${msg}`;
        this.cdr.detectChanges();
      },
    });
  }

  async disconnectVoice(): Promise<void> {
    await this.voice.disconnect();
    this.statusMessage = 'Voice session ended';
    this.cdr.detectChanges();
  }

  async toggleMic(): Promise<void> {
    await this.voice.toggleMic();
    this.cdr.detectChanges();
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

import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterOutlet, Router } from '@angular/router'; // Import Router
import { CommonModule } from '@angular/common';
import { PdfViewerComponent } from './components/pdf-viewer/pdf-viewer.component';
import { AgentResultsPanelComponent, AgentResult } from './components/agent-results-panel/agent-results-panel.component';
import { TutorialComponent } from './components/tutorial/tutorial.component';
import { ApiService } from './services/api.service';
import { VoiceService, TranscriptEntry } from './services/voice.service';
import { AgentService, McpTool } from './services/agent.service';
import { ActivityService } from './services/activity.service';
import { ActionService } from './services/action.service';
import { UserService } from './services/user.service';
import { SessionService, SessionRecord } from './services/session.service';
import { KnowledgeService } from './services/knowledge.service';
import { SessionSummaryPayload } from './models/knowledge.model';
import { Action, HighlightTextPayload, HighlightRegionPayload, NavigateToPagePayload } from './actions';

export interface PaperStackEntry {
  sessionId: string;
  pdfUrl: string;
  fileName: string;
  fromPaperId?: string;
  referenceLabel?: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    PdfViewerComponent,
    AgentResultsPanelComponent,
    FormsModule,
    RouterOutlet,
    TutorialComponent,
  ],
  templateUrl: './app.html',
  styleUrls: ['./app.css'],
})
export class App implements OnInit, OnDestroy {
  showTutorial = true;
  isTutorialActive = true;

  get userName(): string { return this.userService.currentUser?.name || ''; }

  sessionId = '';
  pdfUrl = '';
  uploadedFileName = '';
  statusMessage = 'Welcome to LearnAloud!';

  voiceError = '';

  agentResults: AgentResult[] = [];
  agentResultsCount = 0;
  hasNewResults = false;
  isAgentLoading = false;

  pdfReferences: { number: number; text: string; page: number }[] = [];
  showReferences = false;
  referencesLoading = false;

  mcpTools: McpTool[] = [];
  mcpConnected = false;
  showMcpTools = false;

  transcriptEntries: TranscriptEntry[] = [];

  arxivQuery = '';
  citationRef = '';

  sessionHistory: SessionRecord[] = [];
  showTranscript = false;
  showSessionHistory = false;
  expandedSessionId: string | null = null;
  pendingSessionSummary: SessionSummaryPayload | null = null;
  mcpSearching = false;
  mcpSearchQuery = '';
  agentActivityMessage = '';
  paperStack: PaperStackEntry[] = [];
  activePaperIndex = 0;
  previewPaperIndex: number | null = null;
  showPreviewPanel = false;

  // -- Debate mode --
  isDebateMode = false;
  showModeSelector = false;
  debateReviewerStarted = false;
  private debateRelayTimeout: any = null;
  private debateRelayBuffer: { role: 'author' | 'reviewer'; text: string }[] = [];
  private debateRelayedIds = new Set<string>();

  // -- Split resize --
  previewPanelWidth = 33;
  private isSplitDragging = false;

  // -- Handover / QR --
  showQrModal = false;
  qrCodeDataUrl = '';
  handoverUrl = '';
  private syncInterval: any = null;
  lastSyncedPage = 1;

  private mcpSearchTimeout: any = null;
  private agentActivityTimeout: any = null;

  get lastSession(): SessionRecord | null {
    return this.sessionHistory.length > 0 ? this.sessionHistory[0] : null;
  }

  get isMobileDevice() { return window.innerWidth <= 768; }
  showMobileTranscript = false;

  get isVoiceConnected() { return this.voice.isConnected; }
  get isVoiceConnecting() { return this.voice.isConnecting; }
  get isMicMuted() { return !this.voice.isMicEnabled; }
  get micError() { return this.voice.micError; }
  get isPaused() { return this.voice.isPaused; }
  get debateActiveSpeaker() { return this.voice.activeSpeaker; }
  get isActivityMonitorRoute() { return this.router.url === '/activity-monitor'; }
  get isDashboardRoute() { return this.router.url === '/dashboard'; }

  toggleMobileTranscript(): void {
    this.showMobileTranscript = !this.showMobileTranscript;
    this.cdr.detectChanges();
  }

  constructor(
    private api: ApiService,
    private voice: VoiceService,
    private agentService: AgentService,
    private activity: ActivityService,
    private actionService: ActionService,
    private userService: UserService,
    private sessionService: SessionService,
    private knowledgeService: KnowledgeService,
    private cdr: ChangeDetectorRef,
    private router: Router,
  ) {
    if (this.userService.isLoggedIn() && this.userService.isOnboarded()) {
      this.showTutorial = false;
      this.isTutorialActive = false;
    }
    this.loadSessionHistory();
  }

  ngOnInit(): void {
    this.checkForSessionHandover();
    this.api.connectSocket();

    this.api.onConnect(() => {
      console.log('Connected to LearnAloud server');
      if (!this.isTutorialActive) {
        this.statusMessage = 'Connected to server';
      }
      this.activity.post({ category: 'state', title: 'Connected to server' });
      this.cdr.detectChanges();
    });

    this.api.onClientAction((action: any) => {
      console.log('Received action:', action);
      this.handleClientAction(action);
      this.cdr.detectChanges();
    });

    this.voice.setClientActionHandler((action: any) => {
      console.log('Voice action:', action);
      this.handleClientAction(action);
      this.cdr.detectChanges();
    });

    this.voice.setTranscriptHandler((entries: TranscriptEntry[]) => {
      const prev = this.transcriptEntries;
      this.transcriptEntries = [...entries];

      // Detect new agent entries
      if (entries.length > prev.length) {
        const latest = entries[entries.length - 1];
        if (latest.sender === 'agent' && latest.isFinal) {
          // Clear indicators when agent delivers a substantive result
          // Short filler messages (<80 chars) like "Sure, looking that up" shouldn't clear
          const isSubstantive = latest.text.length > 80;
          if (this.mcpSearching && isSubstantive) {
            this.clearSearchIndicator();
          } else if (this.agentActivityMessage && isSubstantive) {
            this.clearAgentActivity();
          }
          // Fallback: auto-show activity indicator based on what tutor says
          const lower = latest.text.toLowerCase();
          const searchPhrases = ['let me search', 'searching arxiv', 'searching for',
            'i\'ll search', 'i\'ll look up the paper', 'search arxiv'];
          const refPhrases = ['pulling up reference', 'pulling up ref', 'looking up reference',
            'looking up ref', 'let me grab', 'let me find reference', 'let me find ref',
            'let me pull up reference', 'let me pull up ref', 'let me look up reference',
            'fetching reference', 'citation number', 'reference number'];
          const generalWorkPhrases = ['let me pull', 'pulling up', 'looking up',
            'let me look up', 'looking that up', 'let me find', 'let me grab',
            'fetching', 'i\'ll look', 'i\'ll find', 'i\'ll grab', 'i\'ll pull',
            'have it in just', 'give me a moment', 'give me a sec', 'one moment',
            'just a sec', 'just a moment', 'hold on', 'working on that',
            'let me check', 'checking on', 'let me get'];
          if (!this.agentActivityMessage) {
            if (searchPhrases.some(p => lower.includes(p))) {
              const query = latest.text.length > 50
                ? latest.text.substring(0, 50) + '...' : latest.text;
              this.showSearchIndicator(query);
            } else if (refPhrases.some(p => lower.includes(p))) {
              this.showAgentActivity('Looking up reference...');
            } else if (generalWorkPhrases.some(p => lower.includes(p))) {
              this.showAgentActivity('Working on it...');
            }
          }
        }
      }
      // Debate mode: detect student voice keywords to invoke agents
      if (this.isDebateMode) {
        for (const entry of entries) {
          if (entry.sender === 'you' && entry.isFinal) {
            const prevEntry = prev.find(e => e.id === entry.id);
            if (!prevEntry || !prevEntry.isFinal) {
              const lower = entry.text.toLowerCase();
              const reviewerTriggers = [
                'reviewer', 'ask reviewer', 'ask the reviewer',
                'what do you think reviewer', 'reviewer what',
                'critique', 'review this', 'your critique',
                'peer review', 'what does the reviewer think',
                'reviewer opinion', 'reviewer thoughts',
                'let the reviewer', 'bring in the reviewer',
                'over to reviewer', 'pass to reviewer',
              ];
              const authorTriggers = [
                'author', 'ask author', 'ask the author',
                'what do you think author', 'author what',
                'defend', 'respond to that', 'your response',
                'what does the author think', 'author respond',
                'author opinion', 'author thoughts',
                'let the author', 'bring in the author',
                'over to author', 'pass to author',
                'what do you say', 'how do you respond',
              ];
              if (reviewerTriggers.some(t => lower.includes(t))) {
                console.log('[App] Student voice trigger: asking reviewer');
                this.askReviewer();
              } else if (authorTriggers.some(t => lower.includes(t))) {
                console.log('[App] Student voice trigger: asking author');
                this.askAuthor();
              }
            }
          }
        }
      }

      // Post new final entries to the activity monitor
      for (let i = prev.length; i < entries.length; i++) {
        const e = entries[i];
        if (e.isFinal) {
          const senderLabel = this.isDebateMode && e.role
            ? (e.sender === 'you' ? 'You' : e.role === 'author' ? 'Author' : 'Reviewer')
            : (e.sender === 'you' ? 'You' : 'Tutor');
          this.activity.post({
            category: 'transcript',
            title: `${senderLabel}: ${e.text}`,
          });
        }
      }
      this.cdr.detectChanges();
    });
  }

  ngOnDestroy(): void {
    this.stopStateSyncing();
    this.api.disconnectSocket();
    this.voice.disconnect();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;

    const file = input.files[0];
    
    // Reset input to allow re-uploading the same file
    input.value = '';
    
    this.showAgentActivity('Uploading PDF...');
    this.statusMessage = 'Uploading PDF...';
    this.cdr.detectChanges();

    this.api.uploadPDF(file).subscribe({
      next: (res: any) => {
        if (!res || !res.session_id) {
          console.error('Invalid response from server:', res);
          this.statusMessage = 'Upload failed: Invalid server response.';
          this.clearAgentActivity();
          this.cdr.detectChanges();
          return;
        }
        this.sessionId = res.session_id;
        this.pdfUrl = this.api.getPdfUrl(res.session_id);
        this.uploadedFileName = res.filename;

        // Initialize paper stack
        this.paperStack = [{
          sessionId: res.session_id,
          pdfUrl: this.pdfUrl,
          fileName: res.filename,
        }];
        this.activePaperIndex = 0;
        this.previewPaperIndex = null;
        this.showPreviewPanel = false;

        // Show outline info if available
        const outline = res.outline;
        const sectionCount = outline?.sections?.length || 0;
        const figureCount = outline?.figures?.length || 0;
        const keyTerms = outline?.key_terms?.length || 0;
        this.statusMessage = `Loaded "${res.filename}" (${res.total_pages} pages, ${sectionCount} sections, ${figureCount} figures)`;
        this.showAgentActivity('Preparing tutor session...');
        this.activity.post({ category: 'state', title: `PDF uploaded: ${res.filename}`, detail: `${res.total_pages} pages, ${sectionCount} sections, ${figureCount} figures, ${keyTerms} key terms` });
        this.broadcastState();
        this.fetchMcpTools();
        this.loadReferences();
        this.cdr.detectChanges();

        // Show mode selector instead of auto-starting
        this.showModeSelection();
      },
      error: (err) => {
        console.error('Upload failed:', err);
        let errorMsg = 'Upload failed. ';
        if (err.status === 0 || err.name === 'TimeoutError') {
          errorMsg += 'Cannot connect to server. Make sure the backend is running on http://localhost:5000';
        } else if (err.status === 400) {
          errorMsg += err.error?.error || 'Invalid file format.';
        } else if (err.status === 500) {
          errorMsg += err.error?.error || 'Server error processing PDF.';
        } else if (err.status === 404) {
          errorMsg += 'Server endpoint not found.';
        } else {
          errorMsg += err.error?.error || err.message || 'Please try again.';
        }
        this.statusMessage = errorMsg;
        this.cdr.detectChanges();
      },
    });
  }

  startAppFromTutorial(): void {
    this.showTutorial = false;
    this.isTutorialActive = false;
    this.statusMessage = 'Loading sample paper...';
    this.cdr.detectChanges();

    fetch('sample.pdf')
      .then(res => res.blob())
      .then(blob => {
        const file = new File([blob], 'sample.pdf', { type: 'application/pdf' });
        this.api.uploadPDF(file).subscribe({
          next: (res: any) => {
            this.sessionId = res.session_id;
            this.pdfUrl = this.api.getPdfUrl(res.session_id);
            this.uploadedFileName = 'Attention Is All You Need.pdf';

            // Initialize paper stack
            this.paperStack = [{
              sessionId: res.session_id,
              pdfUrl: this.pdfUrl,
              fileName: this.uploadedFileName,
            }];
            this.activePaperIndex = 0;
            this.previewPaperIndex = null;
            this.showPreviewPanel = false;

            this.statusMessage = `Loaded "${this.uploadedFileName}" (${res.total_pages} pages)`;
            this.activity.post({ category: 'state', title: `Sample PDF loaded: ${this.uploadedFileName}`, detail: `${res.total_pages} pages` });
            this.broadcastState();
            this.fetchMcpTools();
            this.loadReferences();
            this.cdr.detectChanges();
            
            // Show mode selector instead of auto-starting
            this.showModeSelection();
          },
          error: (err) => {
            console.error('Sample PDF upload failed:', err);
            this.statusMessage = 'Failed to load sample paper. Try uploading a PDF manually.';
            this.cdr.detectChanges();
          },
        });
      });
  }

  logout(): void {
    this.userService.logout();
    this.showTutorial = true;
    this.isTutorialActive = true;
    this.sessionId = '';
    this.pdfUrl = '';
    this.uploadedFileName = '';
    this.statusMessage = 'Welcome to LearnAloud!';
    this.cdr.detectChanges();
  }

  async startVoiceSession(): Promise<void> {
    if (!this.sessionId) return;
    this.voiceError = '';
    this.cdr.detectChanges();

    this.statusMessage = 'Connecting to tutor...';
    this.cdr.detectChanges();

    this.api.getVoiceToken('student').subscribe({
      next: async (res: any) => {
        try {
          await this.voice.connect(res.livekit_url, res.token);
          this.statusMessage = 'Voice session active';
          this.voiceError = '';
          this.clearAgentActivity();
          this.activity.post({ category: 'state', title: 'Voice session started' });
          this.broadcastState();
          this.startStateSyncing();
          this.cdr.detectChanges();

          // Send PDF context to the agent via data channel
          this.sendPdfContext();
        } catch (e: any) {
          if (this.voice.isConnected) {
            this.statusMessage = 'Voice session active';
            this.voiceError = '';
            this.clearAgentActivity();
            this.sendPdfContext();
          } else {
            this.voiceError = `Failed to connect: ${e.message || e}`;
            this.clearAgentActivity();
          }
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

  showModeSelection(): void {
    this.showModeSelector = true;
    this.clearAgentActivity();
    this.cdr.detectChanges();
  }

  selectTutorMode(): void {
    this.showModeSelector = false;
    this.isDebateMode = false;
    this.cdr.detectChanges();
    setTimeout(() => this.startVoiceSession(), 200);
  }

  selectDebateMode(): void {
    this.showModeSelector = false;
    this.isDebateMode = true;
    this.debateReviewerStarted = false;
    this.cdr.detectChanges();
    setTimeout(() => this.startDebateSession(), 200);
  }

  async startDebateSession(): Promise<void> {
    if (!this.sessionId) return;
    this.voiceError = '';
    this.isDebateMode = true;
    this.statusMessage = 'Connecting debate agents...';
    this.showAgentActivity('Setting up Author vs Reviewer...');
    this.cdr.detectChanges();

    this.api.getDebateTokens('student').subscribe({
      next: async (res: any) => {
        try {
          const authorData = res.author;
          const reviewerData = res.reviewer;
          await this.voice.connectDebate(
            authorData.livekit_url,
            authorData.token,
            reviewerData.livekit_url,
            reviewerData.token,
          );
          this.statusMessage = 'Debate session active — Author vs Reviewer';
          this.voiceError = '';
          this.clearAgentActivity();
          this.activity.post({ category: 'state', title: 'Debate session started' });
          this.broadcastState();
          this.startStateSyncing();
          this.cdr.detectChanges();

          // Send PDF context to author first — author speaks first
          // Reviewer gets context after a delay, and stays silent until [AUTHOR] relay
          this.sendDebatePdfContext();
        } catch (e: any) {
          if (this.voice.isConnected) {
            this.statusMessage = 'Debate session active — Author vs Reviewer';
            this.voiceError = '';
            this.clearAgentActivity();
            this.sendDebatePdfContext();
          } else {
            this.voiceError = `Failed to connect debate: ${e.message || e}`;
            this.clearAgentActivity();
          }
          this.cdr.detectChanges();
        }
      },
      error: (err) => {
        const msg = err.error?.error || err.message || 'Unknown error';
        this.voiceError = `Debate token error: ${msg}`;
        this.clearAgentActivity();
        this.cdr.detectChanges();
      },
    });
  }

  private getRecentAgentText(role: 'author' | 'reviewer'): string {
    // Collect recent final transcript entries from the given role
    const entries = this.transcriptEntries
      .filter(e => e.sender === 'agent' && e.isFinal && e.role === role)
      .slice(-5) // last 5 segments from this role
      .map(e => e.text);
    return entries.join(' ');
  }

  async askReviewer(): Promise<void> {
    if (!this.isDebateMode) return;

    const authorText = this.getRecentAgentText('author');
    if (!authorText) {
      this.statusMessage = 'Wait for the author to speak first';
      this.cdr.detectChanges();
      return;
    }

    // Mute author audio + cut mic in author room so author stops hearing student
    this.voice.muteAgentAudio('author');
    await this.voice.muteLocalMicInRoom('author');

    if (!this.debateReviewerStarted) {
      this.debateReviewerStarted = true;
      this.showAgentActivity('Connecting reviewer...');
      this.cdr.detectChanges();

      await this.voice.connectReviewerRoom();
      this.voice.unmuteAgentAudio('reviewer');

      // Send PDF context to reviewer
      const activeSessionId = this.getActiveSessionId();
      if (activeSessionId) {
        this.api.getPaperContext(activeSessionId).subscribe({
          next: async (res: any) => {
            if (res.context) {
              await this.voice.sendContextToRole(res.context, 'reviewer');
              // After context settles, relay author's points
              setTimeout(async () => {
                await this.voice.relayToAgent('reviewer', `[AUTHOR] ${authorText}`);
                this.clearAgentActivity();
                this.statusMessage = 'Reviewer is responding...';
                this.cdr.detectChanges();
              }, 2000);
            }
          },
          error: (err) => {
            console.error('Failed to send context to reviewer:', err);
            this.clearAgentActivity();
          },
        });
      }
    } else {
      this.voice.unmuteAgentAudio('reviewer');
      await this.voice.unmuteLocalMicInRoom('reviewer');
      await this.voice.relayToAgent('reviewer', `[AUTHOR] ${authorText}`);
      this.statusMessage = 'Reviewer is responding...';
      this.cdr.detectChanges();
    }
  }

  async askAuthor(): Promise<void> {
    if (!this.isDebateMode) return;

    const reviewerText = this.getRecentAgentText('reviewer');
    if (!reviewerText) {
      this.statusMessage = 'Wait for the reviewer to speak first';
      this.cdr.detectChanges();
      return;
    }

    // Mute reviewer audio + cut mic in reviewer room so reviewer stops hearing student
    this.voice.muteAgentAudio('reviewer');
    await this.voice.muteLocalMicInRoom('reviewer');

    // Unmute author audio + restore mic in author room
    this.voice.unmuteAgentAudio('author');
    await this.voice.unmuteLocalMicInRoom('author');

    await this.voice.relayToAgent('author', `[REVIEWER] ${reviewerText}`);
    this.statusMessage = 'Author is responding...';
    this.cdr.detectChanges();
  }

  private sendDebatePdfContext(): void {
    const activeSessionId = this.getActiveSessionId();
    if (!activeSessionId) return;

    // Only send to author — reviewer isn't connected yet
    this.api.getPaperContext(activeSessionId).subscribe({
      next: async (res: any) => {
        if (res.context) {
          await this.voice.sendContextToRole(res.context, 'author');
          console.log('[App] Sent PDF context to author only');
        }
      },
      error: (err) => {
        console.error('Failed to fetch paper context for debate:', err);
      },
    });
  }

  private sendPdfContext(): void {
    const activeSessionId = this.getActiveSessionId();
    if (!activeSessionId) return;

    this.api.getPaperContext(activeSessionId).subscribe({
      next: async (res: any) => {
        if (res.context) {
          await this.voice.sendContext(res.context);
          console.log(`[App] Sent PDF context to agent: ${res.context.length} chars`);
        }
      },
      error: (err) => {
        console.error('Failed to fetch paper context:', err);
      },
    });
  }

  async disconnectVoice(): Promise<void> {
    // Final state sync before disconnecting
    this.syncSessionState();
    this.stopStateSyncing();

    // Save final transcript entries before disconnecting
    const finalEntries = this.transcriptEntries
      .filter(e => e.isFinal)
      .map(e => ({ sender: e.sender, text: e.text }));
    let savedSessionId = '';
    if (finalEntries.length > 0 && this.uploadedFileName) {
      this.sessionService.saveSession(this.uploadedFileName, finalEntries);
      const latest = this.sessionService.getLatestSession();
      if (latest) savedSessionId = latest.id;
      this.loadSessionHistory();
    }

    // Process session summary if the tutor emitted one
    if (this.pendingSessionSummary && savedSessionId) {
      this.knowledgeService.processSessionSummary(this.pendingSessionSummary, savedSessionId);
      this.pendingSessionSummary = null;
    }

    await this.voice.disconnect();
    // Clean up debate state
    this.isDebateMode = false;
    this.debateReviewerStarted = false;
    this.debateRelayBuffer = [];
    this.debateRelayedIds.clear();
    if (this.debateRelayTimeout) {
      clearTimeout(this.debateRelayTimeout);
      this.debateRelayTimeout = null;
    }
    this.statusMessage = 'Voice session ended';
    this.activity.post({ category: 'state', title: 'Voice session ended' });
    this.broadcastState();
    this.cdr.detectChanges();
  }

  async toggleMic(): Promise<void> {
    await this.voice.toggleMic();
    this.cdr.detectChanges();
  }

  async togglePause(): Promise<void> {
    try {
      await this.voice.togglePause();
      this.statusMessage = this.isPaused ? 'Session paused' : 'Session resumed';
      this.activity.post({ category: 'state', title: this.isPaused ? 'Session paused' : 'Session resumed' });
      this.broadcastState();
      this.cdr.detectChanges();
    } catch (error) {
      console.error('Failed to toggle pause:', error);
      this.statusMessage = 'Failed to toggle pause. Please try again.';
      this.cdr.detectChanges();
    }
  }

  loadReferences(): void {
    if (!this.sessionId) return;
    this.referencesLoading = true;
    this.cdr.detectChanges();

    this.agentService.listReferences(this.sessionId).subscribe({
      next: (res) => {
        this.pdfReferences = res.references.map((r: any) => ({
          number: r.number,
          text: r.text,
          page: r.page,
        }));
        this.referencesLoading = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.referencesLoading = false;
        this.cdr.detectChanges();
      },
    });
  }

  toggleReferences(): void {
    this.showReferences = !this.showReferences;
  }

  toggleTranscript(): void {
    this.showTranscript = !this.showTranscript;
  }

  toggleSessionHistory(): void {
    this.showSessionHistory = !this.showSessionHistory;
  }

  startNewSession(): void {
    this.sessionId = '';
    this.pdfUrl = '';
    this.uploadedFileName = '';
    this.statusMessage = 'Upload a PDF to get started';
    this.showSessionHistory = false;
    this.cdr.detectChanges();
  }

  loadSession(session: SessionRecord): void {
    // This would load a previous session - for now just show the session info
    // In a full implementation, you might want to reload the PDF and transcript
    this.statusMessage = `Session: ${session.fileName}`;
    this.cdr.detectChanges();
  }

  focusArxivSearch(): void {
    // Scroll to and focus the ArXiv search input in the controls panel
    const searchInput = document.querySelector('.agent-input') as HTMLInputElement;
    if (searchInput) {
      searchInput.focus();
      searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  toggleSessionExpand(id: string): void {
    this.expandedSessionId = this.expandedSessionId === id ? null : id;
  }

  private loadSessionHistory(): void {
    this.sessionHistory = this.sessionService.getSessions();
  }

  searchReference(ref: { number: number; text: string }): void {
    const clean = ref.text.replace(/^\[\d+\]\s*/, '');
    const query = this.extractTitleFromReference(clean);
    this.handleSearchArxiv({ query });
  }

  private extractTitleFromReference(text: string): string {
    // Academic references typically follow: "Authors. Title. Venue, year."
    // Strategy: split on periods, find the segment that looks like a title
    // (not just names, not a venue/year, not a URL).

    // Remove arXiv IDs and URLs for cleaner parsing
    const cleaned = text
      .replace(/arXiv preprint arXiv:\s*\S+/gi, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/doi:\s*\S+/gi, '')
      .trim();

    // Split on ". " (period followed by space) to get segments
    const segments = cleaned.split(/\.\s+/).map(s => s.trim()).filter(s => s.length > 5);

    if (segments.length <= 1) {
      // Can't split — just use first 80 chars
      return cleaned.substring(0, 80);
    }

    // The title is usually the segment after the authors.
    // Author segments typically have: commas, "and", single capitalized words.
    // Title segments are longer phrases, often with lowercase words.
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      // Skip segments that look like author lists (contain "and" between names, or are mostly proper nouns)
      const looksLikeAuthors = /^[A-Z][a-z]+ [A-Z]/.test(seg) && (seg.includes(',') || seg.includes(' and '));
      // Skip segments that look like venue/year ("In Proceedings...", "NeurIPS", just a year)
      const looksLikeVenue = /^(In |Proceedings|IEEE|ACM|ICML|NeurIPS|ICLR|AAAI|CVPR|\d{4})/i.test(seg);
      // Skip very short segments
      if (!looksLikeAuthors && !looksLikeVenue && seg.length > 10) {
        return seg.substring(0, 100);
      }
    }

    // Fallback: use the second segment (skip authors)
    return segments.length > 1
      ? segments[1].substring(0, 100)
      : segments[0].substring(0, 80);
  }

  clearNewResults(): void {
    this.hasNewResults = false;
  }

  triggerArxivSearch(): void {
    if (!this.arxivQuery.trim()) return;
    this.handleSearchArxiv({ query: this.arxivQuery.trim() });
  }

  triggerCitationLookup(): void {
    if (!this.citationRef.trim()) return;
    this.handleFindCitation({ reference: this.citationRef.trim() });
  }

  triggerListReferences(): void {
    if (!this.sessionId) return;
    this.isAgentLoading = true;
    this.cdr.detectChanges();

    this.agentService.listReferences(this.sessionId).subscribe({
      next: (res) => {
        for (const ref of res.references) {
          this.agentResults = [
            ...this.agentResults,
            { type: 'citation', result: ref as any },
          ];
        }
        this.isAgentLoading = false;
        this.statusMessage = `Found ${res.count} references`;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('List references failed:', err);
        this.isAgentLoading = false;
        this.cdr.detectChanges();
      },
    });
  }

  onDownloadPaper(arxivId: string): void {
    this.isAgentLoading = true;
    this.showAgentActivity(`Downloading paper ${arxivId}...`);

    this.agentService.downloadPaper(arxivId).subscribe({
      next: (res) => {
        const pdfUrl = this.api.getPdfUrl(res.session_id);
        const newEntry: PaperStackEntry = {
          sessionId: res.session_id,
          pdfUrl,
          fileName: res.filename,
          fromPaperId: this.getActiveSessionId(),
          referenceLabel: `Reference (${arxivId})`,
        };
        this.paperStack.push(newEntry);
        this.previewPaperIndex = this.paperStack.length - 1;
        this.showPreviewPanel = true;
        this.statusMessage = `Preview: "${res.filename}"`;
        this.isAgentLoading = false;
        this.clearAgentActivity();
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Download failed:', err);
        this.statusMessage = 'Paper download failed.';
        this.isAgentLoading = false;
        this.clearAgentActivity();
        this.cdr.detectChanges();
      },
    });
  }

  // -- Paper stack helpers --

  getActivePdfUrl(): string {
    return this.paperStack[this.activePaperIndex]?.pdfUrl || this.pdfUrl;
  }

  getActiveSessionId(): string {
    return this.paperStack[this.activePaperIndex]?.sessionId || this.sessionId;
  }

  getPreviewPdfUrl(): string {
    if (this.previewPaperIndex === null) return '';
    return this.paperStack[this.previewPaperIndex]?.pdfUrl || '';
  }

  getPreviewSessionId(): string {
    if (this.previewPaperIndex === null) return '';
    return this.paperStack[this.previewPaperIndex]?.sessionId || '';
  }

  getPreviewPaperName(): string {
    if (this.previewPaperIndex === null) return '';
    return this.paperStack[this.previewPaperIndex]?.fileName || '';
  }

  switchToPreviewPaper(): void {
    if (this.previewPaperIndex === null) return;
    const previousActive = this.activePaperIndex;
    this.activePaperIndex = this.previewPaperIndex;
    this.previewPaperIndex = previousActive;
    this.notifyPaperSwitch(this.getActiveSessionId());
    this.sendPdfContext();
    this.cdr.detectChanges();
  }

  switchToMainPaper(): void {
    if (this.activePaperIndex === 0) return;
    const previousActive = this.activePaperIndex;
    this.activePaperIndex = 0;
    this.previewPaperIndex = previousActive;
    this.showPreviewPanel = true;
    this.notifyPaperSwitch(this.getActiveSessionId());
    this.sendPdfContext();
    this.cdr.detectChanges();
  }

  closePreview(): void {
    this.showPreviewPanel = false;
    this.previewPaperIndex = null;
    this.cdr.detectChanges();
  }

  onSplitHandleMouseDown(event: MouseEvent): void {
    event.preventDefault();
    this.isSplitDragging = true;
    const container = (event.target as HTMLElement).parentElement;
    if (!container) return;

    const onMouseMove = (e: MouseEvent) => {
      if (!this.isSplitDragging) return;
      const rect = container.getBoundingClientRect();
      const offsetFromRight = rect.right - e.clientX;
      const pct = (offsetFromRight / rect.width) * 100;
      this.previewPanelWidth = Math.max(15, Math.min(70, pct));
      this.cdr.detectChanges();
    };

    const onMouseUp = () => {
      this.isSplitDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  onPageChanged(event: { page: number; totalPages: number }): void {
    this.lastSyncedPage = event.page;
    if (!this.voice.isConnected) return;
    this.voice.sendData({
      type: 'page_context',
      page: event.page,
      totalPages: event.totalPages,
      fileName: this.paperStack[this.activePaperIndex]?.fileName || this.uploadedFileName,
      sessionId: this.getActiveSessionId(),
    });
  }

  private sendContextReinforcement(): void {
    const entry = this.paperStack[this.activePaperIndex];
    if (!entry) return;
    this.voice.sendData({
      type: 'context_reinforcement',
      fileName: entry.fileName,
      sessionId: entry.sessionId,
      message: `The student is viewing "${entry.fileName}". You have the full text of this paper. Never ask which paper they are reading.`,
    });
  }

  private notifyPaperSwitch(sessionId: string): void {
    const entry = this.paperStack.find(p => p.sessionId === sessionId);
    this.voice.sendData({
      type: 'paper_switched',
      sessionId,
      fileName: entry?.fileName || '',
      referenceLabel: entry?.referenceLabel || '',
    });
  }

  fetchMcpTools(): void {
    this.agentService.getMcpTools().subscribe({
      next: (res) => {
        this.mcpTools = res.tools;
        this.mcpConnected = res.status === 'connected';
        if (this.mcpConnected) {
          this.activity.post({
            category: 'mcp',
            title: `MCP connected: ${res.tools.length} tools available`,
            detail: res.tools.map((t) => t.name).join(', '),
          });
        }
        this.broadcastState();
        this.cdr.detectChanges();
      },
      error: () => {
        this.mcpConnected = false;
        this.mcpTools = [];
        this.cdr.detectChanges();
      },
    });
  }

  toggleMcpTools(): void {
    this.showMcpTools = !this.showMcpTools;
  }

  openDashboard(): void {
    this.router.navigate(['/dashboard']);
  }

  openActivityMonitor(): void {
    window.open(
      '/activity-monitor',
      'activity-monitor',
      'width=600,height=700,scrollbars=yes,resizable=yes',
    );
    // Send current state so the new window gets initial values
    setTimeout(() => this.broadcastState(), 500);
  }

  private broadcastState(): void {
    this.activity.postState({
      voiceConnected: this.isVoiceConnected,
      voicePaused: this.isPaused,
      mcpConnected: this.mcpConnected,
      sessionId: this.sessionId,
      fileName: this.uploadedFileName,
    });
  }

  private handleClientAction(action: any): void {
    // In debate mode, force author=blue, reviewer=pink for highlights
    const debateRole: string | undefined = action._debateRole;

    if (action.type === 'highlight_text') {
      let color = action.payload.color || 'yellow';
      if (this.isDebateMode && debateRole) {
        color = debateRole === 'author' ? 'blue' : 'pink';
      }
      const payload: HighlightTextPayload = {
        text: action.payload.text,
        color,
        page: action.payload.page || 1,
        sessionId: action.payload.session_id || this.getActiveSessionId(),
      };
      this.actionService.dispatch({ type: 'HIGHLIGHT_TEXT', payload });
      this.activity.post({
        category: 'action',
        title: `Highlight: "${payload.text.substring(0, 50)}${payload.text.length > 50 ? '...' : ''}"`,
        detail: `Page ${payload.page}, color: ${payload.color}`,
      });
    } else if (action.type === 'highlight_region') {
      let regionColor = action.payload.color || 'rgba(255, 255, 0, 0.3)';
      if (this.isDebateMode && debateRole) {
        regionColor = debateRole === 'author' ? 'rgba(33, 150, 243, 0.3)' : 'rgba(233, 30, 99, 0.3)';
      }
      const payload: HighlightRegionPayload = {
        x: action.payload.x,
        y: action.payload.y,
        w: action.payload.w,
        h: action.payload.h,
        page: action.payload.page || 1,
        color: regionColor,
        sessionId: action.payload.session_id || this.getActiveSessionId(),
      };
      this.actionService.dispatch({ type: 'HIGHLIGHT_REGION', payload });
      this.activity.post({
        category: 'action',
        title: `Highlight Region on Page ${payload.page}`,
        detail: `[${payload.x}, ${payload.y}, ${payload.w}, ${payload.h}]`,
      });
    }
    else if (action.type === 'navigate_to_page') {
      const page = action.payload?.page;
      if (page) {
        const payload: NavigateToPagePayload = {
          page,
          sessionId: action.payload.session_id || this.getActiveSessionId(),
        };
        this.actionService.dispatch({ type: 'NAVIGATE_TO_PAGE', payload });
        this.activity.post({
          category: 'action',
          title: `Navigate to page ${page}`,
        });
      }
    } else if (action.type === 'search_arxiv') {
      this.activity.post({
        category: 'action',
        title: `Search ArXiv: "${action.payload?.query}"`,
      });
      this.handleSearchArxiv(action.payload);
    } else if (action.type === 'find_citation') {
      this.showAgentActivity(`Looking up reference ${action.payload?.reference}...`);
      this.activity.post({
        category: 'action',
        title: `Find Citation: "${action.payload?.reference}"`,
      });
      this.handleFindCitation(action.payload);
    } else if (action.type === 'download_paper') {
      const arxivId = action.payload?.arxiv_id;
      if (arxivId) {
        this.activity.post({ category: 'action', title: `Download paper: ${arxivId}` });
        this.onDownloadPaper(arxivId);
      }
    } else if (action.type === 'searching_arxiv') {
      this.showSearchIndicator(action.payload?.query || 'papers');
      this.activity.post({
        category: 'action',
        title: `MCP searching: "${this.mcpSearchQuery}"`,
      });
    } else if (action.type === 'search_complete') {
      this.clearSearchIndicator();
    } else if (action.type === 'session_summary') {
      this.pendingSessionSummary = action.payload as SessionSummaryPayload;
      this.activity.post({
        category: 'action',
        title: 'Session summary received',
        detail: `${this.pendingSessionSummary.concepts?.length || 0} concepts, performance: ${this.pendingSessionSummary.overallPerformance}`,
      });
    }
  }

  startQuiz(): void {
    if (!this.sessionId || !this.voice.isConnected) {
      this.statusMessage = 'Please start a voice session first';
      this.cdr.detectChanges();
      return;
    }

    this.statusMessage = 'Activating quiz mode...';
    this.cdr.detectChanges();

    // Tell the backend to activate quiz mode for this session
    this.api.startQuiz(this.sessionId).subscribe({
      next: (res: any) => {
        // Fetch quiz context and send it over the existing voice connection
        this.api.getPaperContext(this.sessionId).subscribe({
          next: async (contextRes: any) => {
            if (contextRes.context) {
              await this.voice.sendContext(contextRes.context);
              this.statusMessage = 'Quiz started! The tutor will now ask you questions.';
              this.activity.post({ category: 'state', title: 'Quiz mode activated' });
              this.cdr.detectChanges();
            }
          },
          error: (err) => {
            console.error('Failed to fetch quiz context:', err);
            this.statusMessage = 'Failed to load quiz context';
            this.cdr.detectChanges();
          },
        });
      },
      error: (err) => {
        console.error('Failed to start quiz:', err);
        this.statusMessage = 'Failed to start quiz mode';
        this.cdr.detectChanges();
      },
    });
  }

  private showSearchIndicator(query: string): void {
    this.mcpSearching = true;
    this.mcpSearchQuery = query;
    this.showAgentActivity(`Searching ArXiv for "${query}"...`);
    // Auto-clear after 15 seconds in case no search_complete or follow-up arrives
    if (this.mcpSearchTimeout) clearTimeout(this.mcpSearchTimeout);
    this.mcpSearchTimeout = setTimeout(() => {
      if (this.mcpSearching) {
        this.mcpSearching = false;
        this.mcpSearchQuery = '';
        this.cdr.detectChanges();
      }
    }, 15000);
  }

  private clearSearchIndicator(): void {
    this.mcpSearching = false;
    this.mcpSearchQuery = '';
    this.clearAgentActivity();
    if (this.mcpSearchTimeout) {
      clearTimeout(this.mcpSearchTimeout);
      this.mcpSearchTimeout = null;
    }
    this.cdr.detectChanges();
  }

  private showAgentActivity(message: string, timeoutMs = 20000): void {
    this.agentActivityMessage = message;
    if (this.agentActivityTimeout) clearTimeout(this.agentActivityTimeout);
    this.agentActivityTimeout = setTimeout(() => {
      this.agentActivityMessage = '';
      this.cdr.detectChanges();
    }, timeoutMs);
    this.cdr.detectChanges();
  }

  private clearAgentActivity(): void {
    this.agentActivityMessage = '';
    if (this.agentActivityTimeout) {
      clearTimeout(this.agentActivityTimeout);
      this.agentActivityTimeout = null;
    }
  }

  private handleSearchArxiv(payload: any): void {
    const query = payload?.query;
    if (!query) return;

    this.isAgentLoading = true;
    this.cdr.detectChanges();

    this.agentService.searchArxiv(query).subscribe({
      next: (res) => {
        this.agentResults = [
          ...this.agentResults,
          { type: 'arxiv_search', query: res.query, papers: res.papers, mcp_info: res.mcp_info },
        ];
        this.hasNewResults = true;
        this.isAgentLoading = false;
        if (res.mcp_info) {
          this.activity.post({
            category: 'mcp',
            title: `Tool: ${res.mcp_info.tool}`,
            detail: `Args: ${JSON.stringify(res.mcp_info.arguments)}
Completed in ${res.mcp_info.duration_ms}ms`,
            metadata: res.mcp_info,
          });
        }
        this.activity.post({
          category: 'action',
          title: `Search complete: ${res.papers.length} papers found`,
        });
        this.cdr.detectChanges();
        this.voice.publishData({
          type: 'arxiv_results',
          query: res.query,
          count: res.papers.length,
          papers: res.papers.map((p) => ({ title: p.title, arxiv_id: p.arxiv_id })),
        });
      },
      error: (err) => {
        console.error('ArXiv search failed:', err);
        this.isAgentLoading = false;
        this.cdr.detectChanges();
      },
    });
  }

  private handleFindCitation(payload: any): void {
    const reference = payload?.reference;
    const activeSession = this.getActiveSessionId();
    if (!reference || !activeSession) return;

    this.isAgentLoading = true;
    this.cdr.detectChanges();

    this.agentService.findCitation(activeSession, reference).subscribe({
      next: (res) => {
        this.agentResults = [
          ...this.agentResults,
          { type: 'citation', result: res },
        ];
        this.isAgentLoading = false;
        this.activity.post({
          category: 'action',
          title: res.found ? `Citation found: [${res.number}] on page ${res.page}` : 'Citation not found',
          detail: res.text,
        });

        if (res.found && res.text) {
          // Strip leading [N] prefix and use the actual reference content
          const cleanText = res.text.replace(/^\[\d+\]\s*/, '');
          // Use a short unique portion — first 40 chars of actual content
          const highlightText = cleanText.substring(0, Math.min(40, cleanText.length));
          this.actionService.dispatch({
            type: 'HIGHLIGHT_TEXT',
            payload: { text: highlightText, color: 'pink', page: res.page || 1 } as HighlightTextPayload
          });
        }
        this.cdr.detectChanges();
        this.voice.publishData({
          type: 'citation_result',
          found: res.found,
          number: res.number,
          text: res.text,
          page: res.page,
        });
      },
      error: (err) => {
        console.error('Citation lookup failed:', err);
        this.isAgentLoading = false;
        this.clearAgentActivity();
        const msg = err.status === 404
          ? 'Session expired — re-upload the PDF to restore citation lookup.'
          : 'Citation lookup failed.';
        this.statusMessage = msg;
        this.voice.publishData({
          type: 'citation_result',
          found: false,
          error: msg,
        });
        this.cdr.detectChanges();
      },
    });
  }

  // -- State syncing for cross-device handover --

  private startStateSyncing(): void {
    this.stopStateSyncing();
    this.syncInterval = setInterval(() => this.syncSessionState(), 10000);
  }

  private stopStateSyncing(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  private syncSessionState(): void {
    const sid = this.getActiveSessionId();
    if (!sid) return;

    const finalEntries = this.transcriptEntries.filter(e => e.isFinal);
    const recentEntries = finalEntries.slice(-10);
    const summary = recentEntries
      .map(e => `${e.sender === 'you' ? 'Student' : 'Tutor'}: ${e.text}`)
      .join(' | ')
      .substring(0, 500);

    this.api.updateSessionState(sid, {
      current_page: this.lastSyncedPage,
      transcript_summary: summary,
    }).subscribe({
      error: (err) => console.error('State sync failed:', err),
    });
  }

  // -- QR / handover UI --

  showContinueOnPhone(): void {
    const sid = this.getActiveSessionId();
    if (!sid) return;

    // Sync state immediately before showing QR
    this.syncSessionState();

    // Disconnect desktop voice so the phone session can take over
    if (this.isVoiceConnected) {
      this.disconnectVoice();
    }

    // Try to get ngrok tunnel URL for cross-device access
    this.api.getTunnelUrl().subscribe({
      next: (res: any) => {
        const origin = res.url || window.location.origin;
        this.handoverUrl = `${origin}?session=${sid}`;
        this.qrCodeDataUrl = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(this.handoverUrl)}`;
        this.showQrModal = true;
        this.statusMessage = 'Voice session handed over to phone';
        this.cdr.detectChanges();
      },
      error: () => {
        this.handoverUrl = `${window.location.origin}?session=${sid}`;
        this.qrCodeDataUrl = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(this.handoverUrl)}`;
        this.showQrModal = true;
        this.statusMessage = 'Voice session handed over to phone';
        this.cdr.detectChanges();
      },
    });
  }

  closeQrModal(): void {
    this.showQrModal = false;
    this.cdr.detectChanges();
  }

  copyUrlToClipboard(): void {
    navigator.clipboard.writeText(this.handoverUrl).then(() => {
      this.statusMessage = 'URL copied to clipboard';
      this.cdr.detectChanges();
    });
  }

  // -- Session handover from URL --

  private checkForSessionHandover(): void {
    const params = new URLSearchParams(window.location.search);
    let handoverSessionId = params.get('session');

    // If no URL param, check sessionStorage for a persisted handover session
    if (!handoverSessionId) {
      handoverSessionId = sessionStorage.getItem('learnaloud_handover_session');
    }

    if (handoverSessionId) {
      // Persist so it survives page reloads / phone lock-unlock
      sessionStorage.setItem('learnaloud_handover_session', handoverSessionId);
      // Skip tutorial for handover
      this.showTutorial = false;
      this.isTutorialActive = false;
      // Clean URL
      window.history.replaceState({}, document.title, window.location.pathname);
      this.loadSessionFromHandover(handoverSessionId);
    }
  }

  private loadSessionFromHandover(sessionId: string): void {
    this.statusMessage = 'Loading session from other device...';
    this.showAgentActivity('Loading handover session...');
    this.cdr.detectChanges();

    this.api.getPaperContext(sessionId).subscribe({
      next: (res: any) => {
        this.sessionId = sessionId;
        this.pdfUrl = this.api.getPdfUrl(sessionId);
        this.uploadedFileName = res.filename || 'Handed-over paper';

        // Initialize paper stack
        this.paperStack = [{
          sessionId,
          pdfUrl: this.pdfUrl,
          fileName: this.uploadedFileName,
        }];
        this.activePaperIndex = 0;

        // Navigate to the page the other device was on
        if (res.current_page && res.current_page > 1) {
          this.lastSyncedPage = res.current_page;
          setTimeout(() => {
            this.actionService.dispatch({
              type: 'NAVIGATE_TO_PAGE',
              payload: { page: res.current_page, sessionId } as NavigateToPagePayload,
            });
          }, 1000);
        }

        this.statusMessage = `Continuing "${this.uploadedFileName}" from another device`;
        this.clearAgentActivity();
        this.broadcastState();
        this.fetchMcpTools();
        this.loadReferences();
        this.cdr.detectChanges();

        // Auto-start voice on desktop; on mobile, require a tap (browser mic policy)
        if (!this.isMobileDevice) {
          setTimeout(() => {
            this.startVoiceSession();
          }, 500);
        } else {
          this.statusMessage = 'Tap "Start Tutor" to continue the session';
        }
      },
      error: (err) => {
        console.error('Handover session load failed:', err);
        this.statusMessage = 'Failed to load session. It may have expired.';
        this.clearAgentActivity();
        this.cdr.detectChanges();
      },
    });
  }
}
import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';

import { WaveformComponent } from '../components/shared/waveform/waveform.component';
import { PdfViewerComponent } from '../components/pdf-viewer/pdf-viewer.component';
import { VoiceService, TranscriptEntry } from '../services/voice.service';
import { SessionService } from '../services/session.service';
import { ApiService } from '../services/api.service';
import { ActionService } from '../services/action.service';
import { HighlightTextPayload, HighlightRegionPayload, NavigateToPagePayload } from '../actions';

export type SpeakingState = 'tutor-speaking' | 'user-speaking' | 'ready';

export interface TranscriptMessage {
  id: string;
  role: 'tutor' | 'user';
  text: string;
  page?: number;
  timestamp: number;
  isFinal: boolean;
}

export interface ProgressData {
  coverage: number;
  depth: number;
  heatmap: number[]; // 12 segments, 0-1 values
}

@Component({
  selector: 'app-session-view',
  standalone: true,
  imports: [CommonModule, FormsModule, WaveformComponent, PdfViewerComponent],
  templateUrl: './session-view.component.html',
  styleUrl: './session-view.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionViewComponent implements OnInit, OnDestroy {
  // --- Inputs (data from parent/service) ---
  @Input() documentTitle = 'Document';
  @Input() currentPage = 1;
  @Input() totalPages = 1;
  @Input() speakingState: SpeakingState = 'ready';
  @Input() isPaused = false;
  @Input() isMicEnabled = true;
  @Input() transcript: TranscriptMessage[] = [];
  @Input() progress: ProgressData = { coverage: 0, depth: 0, heatmap: Array(12).fill(0) };
  @Input() sessionStartTime = Date.now();

  // --- Outputs (events to parent/service) ---
  @Output() back = new EventEmitter<void>();
  @Output() pause = new EventEmitter<void>();
  @Output() resume = new EventEmitter<void>();
@Output() end = new EventEmitter<void>();
  @Output() sendMessage = new EventEmitter<string>();
  @Output() toggleMic = new EventEmitter<void>();

  // --- Route-driven state ---
  routeSessionId = '';
  pdfUrl = '';

  // --- Local state ---
  chatText = '';
  showOnboarding = false;
  private onboardingKey = 'learnaloud_onboarded';
  isPttActive = false;           // true while user is holding the PTT button
  private autoMutedByAgent = false; // true while mic was muted because agent started speaking

  // --- Trial gate ---
  private readonly TRIAL_SECONDS = 60;
  private readonly SIGNED_IN_KEY = 'learnaloud_user';
  private readonly TOKEN_KEY = 'learnaloud_token';
  showAuthGate = false;
  trialSecondsLeft = 60;
  signupSubmitting = false;
  signupError = '';
  private trialIntervalId: any = null;
  private sessionStarted = false; // true once voice.connect() succeeds

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private cdr: ChangeDetectorRef,
    private voice: VoiceService,
    public sessionService: SessionService,
    private api: ApiService,
    private actionService: ActionService,
  ) {}

  ngOnInit(): void {
    // Read session ID from route and build PDF URL
    this.routeSessionId = this.route.snapshot.paramMap.get('sessionId') ?? '';
    if (this.routeSessionId) {
      this.pdfUrl = `/api/pdf/${this.routeSessionId}`;
    }

    // Check if user has been onboarded
    const onboarded = localStorage.getItem(this.onboardingKey);
    this.showOnboarding = !onboarded;

    // Wire voice data channel → PDF highlight/navigation actions
    this.voice.setClientActionHandler((action: any) => {
      this.handleClientAction(action);
      this.cdr.markForCheck();
    });

    // Wire transcript updates → local transcript array + speaking state
    this.voice.setTranscriptHandler((entries: TranscriptEntry[]) => {
      this.updateTranscriptFromEntries(entries);
      this.cdr.markForCheck();
    });

    // Start voice session
    this.startVoiceSession();
    this.initGoogleSignIn();

    // Start progress polling
    if (this.routeSessionId) {
      this.sessionService.startProgressPolling(this.routeSessionId);
    }
  }

  private startTrialTimer(): void {
    this.trialSecondsLeft = this.TRIAL_SECONDS;
    this.trialIntervalId = setInterval(() => {
      this.trialSecondsLeft--;
      this.cdr.markForCheck();
      if (this.trialSecondsLeft <= 0) {
        clearInterval(this.trialIntervalId);
        this.trialIntervalId = null;
        this.triggerAuthGate();
      }
    }, 1000);
  }

  private triggerAuthGate(): void {
    // Clear expired trial token so interceptor stops sending it
    localStorage.removeItem(this.TOKEN_KEY);
    if (!this.isPaused) {
      this.voice.togglePause().then(() => {
        this.isPaused = this.voice.isPaused;
        this.cdr.markForCheck();
      });
    }
    this.showAuthGate = true;
    this.cdr.markForCheck();
    setTimeout(() => this.renderGoogleButton(), 50);
  }

  private initGoogleSignIn(): void {
    const clientId = (window as any).GOOGLE_CLIENT_ID;
    if (!clientId || !(window as any).google) return;
    (window as any).google.accounts.id.initialize({
      client_id: clientId,
      callback: (response: any) => this.onGoogleCredential(response),
    });
  }

  private renderGoogleButton(): void {
    const el = document.getElementById('google-signin-btn');
    if (!el || !(window as any).google) return;
    (window as any).google.accounts.id.renderButton(el, {
      theme: 'outline', size: 'large', width: 340, text: 'continue_with',
    });
  }

  onGoogleCredential(response: any): void {
    this.signupSubmitting = true;
    this.signupError = '';
    this.cdr.markForCheck();
    this.api.googleSignin(response.credential).subscribe({
      next: (res: any) => {
        localStorage.setItem(this.TOKEN_KEY, res.token);
        localStorage.setItem(this.SIGNED_IN_KEY, JSON.stringify(res.user));
        this.showAuthGate = false;
        this.signupSubmitting = false;
        this.cdr.markForCheck();
        (window as any).gtag?.('event', 'login', { method: 'Google' });
        if (this.sessionStarted) {
          // Trial expired: voice is already connected but paused — just resume
          if (this.isPaused) {
            this.voice.togglePause().then(() => {
              this.isPaused = this.voice.isPaused;
              this.isMicEnabled = this.voice.isMicEnabled;
              this.cdr.markForCheck();
              // Nudge agent to resume speaking automatically
              this.voice.publishData(
                { type: 'client_action', action: 'text_input', payload: { text: 'please continue' } },
                'client_actions',
              );
            });
          }
        } else {
          // No session yet (trial token fetch failed) — start fresh
          this.startVoiceSession();
        }
      },
      error: () => {
        this.signupError = 'Sign-in failed. Please try again.';
        this.signupSubmitting = false;
        this.cdr.markForCheck();
      },
    });
  }

  ngOnDestroy(): void {
    this.sessionService.stopProgressPolling();
    this.voice.disconnect();
    clearInterval(this.trialIntervalId);
  }

  // --- PDF viewer ---
  onPdfPageChanged(event: { page: number; totalPages: number }): void {
    this.currentPage = event.page;
    this.totalPages = event.totalPages;
    this.cdr.markForCheck();
  }

  // --- Onboarding ---
  dismissOnboarding(): void {
    localStorage.setItem(this.onboardingKey, 'true');
    this.showOnboarding = false;
    this.cdr.markForCheck();
  }

  // --- Voice session startup ---
  private startVoiceSession(): void {
    if (!this.routeSessionId) return;

    // If no token, fetch a short-lived trial JWT first, then retry
    if (!localStorage.getItem(this.TOKEN_KEY)) {
      this.api.getTrialToken().subscribe({
        next: (res: any) => {
          localStorage.setItem(this.TOKEN_KEY, res.token);
          this.startVoiceSession();
        },
        error: () => {
          // Trial token failed — show auth gate immediately
          this.showAuthGate = true;
          this.cdr.markForCheck();
          setTimeout(() => this.renderGoogleButton(), 50);
        },
      });
      return;
    }

    this.api.getVoiceToken('student').subscribe({
      next: async (res: any) => {
        try {
          await this.voice.connect(res.livekit_url, res.token);
          this.sessionStarted = true;
          this.isMicEnabled = this.voice.isMicEnabled;
          this.cdr.markForCheck();

          // Start 60-second trial timer for unauthenticated users
          if (!localStorage.getItem(this.SIGNED_IN_KEY)) {
            this.startTrialTimer();
          }

          // Send PDF context to the agent via data channel
          this.api.getPaperContext(this.routeSessionId).subscribe({
            next: async (ctx: any) => {
              if (ctx.context) {
                await this.voice.sendContext(ctx.context);
                console.log('[SessionView] PDF context sent to agent');
              }
            },
            error: (err: any) =>
              console.warn('[SessionView] Failed to get paper context:', err),
          });
        } catch (e: any) {
          console.error('[SessionView] Voice connect failed:', e);
          this.isMicEnabled = false;
          this.cdr.markForCheck();
        }
      },
      error: (err: any) => {
        if (err.status === 401) {
          // Stale or expired token — clear it and retry (fetches a fresh trial token)
          localStorage.removeItem(this.TOKEN_KEY);
          this.startVoiceSession();
        } else {
          console.error('[SessionView] Failed to get voice token:', err);
        }
      },
    });
  }

  // --- Client action handler (LiveKit data channel → ActionService) ---
  private handleClientAction(action: any): void {
    console.log('[SessionView] handleClientAction:', action.type, action.payload);
    if (action.type === 'highlight_text') {
      const payload: HighlightTextPayload = {
        text: action.payload.text,
        color: action.payload.color || 'yellow',
        page: action.payload.page || 1,
        // Omit sessionId so shouldHandleAction uses the !isPreview fallback (always true
        // for the main viewer). Avoids session-ID mismatch between parent and child.
      };
      this.actionService.dispatch({ type: 'HIGHLIGHT_TEXT', payload });
      this.sessionService.sendCoverageUpdate(
        this.routeSessionId,
        action.payload.page || 1,
        action.payload.text,
        this.totalPages,
      );
    } else if (action.type === 'highlight_region') {
      const payload: HighlightRegionPayload = {
        x: action.payload.x,
        y: action.payload.y,
        w: action.payload.w,
        h: action.payload.h,
        page: action.payload.page || 1,
        color: action.payload.color || 'rgba(255, 255, 0, 0.3)',
      };
      this.actionService.dispatch({ type: 'HIGHLIGHT_REGION', payload });
    } else if (action.type === 'navigate_to_page') {
      const page = action.payload?.page;
      if (page) {
        const payload: NavigateToPagePayload = { page };
        this.actionService.dispatch({ type: 'NAVIGATE_TO_PAGE', payload });
      }
    }
  }

  // --- Push-to-talk handlers ---
  onPttStart(): void {
    this.isPttActive = true;
    this.voice.setMicEnabled(true).then(() => {
      this.isMicEnabled = true;
      this.cdr.markForCheck();
    });
  }

  onPttEnd(): void {
    this.isPttActive = false;
    // Re-mute only if agent is still speaking; otherwise leave mic on
    if (this.speakingState === 'tutor-speaking') {
      this.voice.setMicEnabled(false).then(() => {
        this.isMicEnabled = false;
        this.cdr.markForCheck();
      });
    }
  }

  // --- Transcript: LiveKit entries → UI messages + speaking state ---
  private updateTranscriptFromEntries(entries: TranscriptEntry[]): void {
    // Detect speaking state from the latest non-final segment
    const latest = entries[entries.length - 1];
    const prevState = this.speakingState;
    if (latest && !latest.isFinal) {
      this.speakingState = latest.sender === 'agent' ? 'tutor-speaking' : 'user-speaking';
    } else if (latest && latest.isFinal) {
      this.speakingState = 'ready';
    }

    // Auto-mute mic when agent starts speaking (unless user is holding PTT)
    if (prevState !== 'tutor-speaking' && this.speakingState === 'tutor-speaking') {
      if (this.isMicEnabled && !this.isPttActive) {
        this.autoMutedByAgent = true;
        this.voice.setMicEnabled(false).then(() => {
          this.isMicEnabled = false;
          this.cdr.markForCheck();
        });
      }
    } else if (prevState === 'tutor-speaking' && this.speakingState !== 'tutor-speaking') {
      // Agent finished speaking — restore mic if we were the one who muted it
      if (this.autoMutedByAgent && !this.isPttActive) {
        this.autoMutedByAgent = false;
        this.voice.setMicEnabled(true).then(() => {
          this.isMicEnabled = true;
          this.cdr.markForCheck();
        });
      }
    }

    // Show all non-empty messages; non-final entries render as live captions
    this.transcript = entries
      .filter((e) => e.text.trim())
      .map((e) => ({
        id: e.id,
        role: (e.sender === 'agent' ? 'tutor' : 'user') as 'tutor' | 'user',
        text: e.text,
        timestamp: Date.now(),
        isFinal: e.isFinal,
      }));
  }

  // --- Control handlers ---
  onBack(): void {
    this.back.emit();
    this.router.navigate(['/library']);
  }

  onPauseToggle(): void {
    // Emit before toggle so parent (if any) gets current state
    if (this.isPaused) {
      this.resume.emit();
    } else {
      this.pause.emit();
    }
    this.voice.togglePause().then(() => {
      this.isPaused = this.voice.isPaused;
      this.isMicEnabled = this.voice.isMicEnabled;
      this.cdr.markForCheck();
    });
  }

onEnd(): void {
    this.end.emit();
    this.voice.disconnect();
    this.router.navigate(['/library']);
  }

  onToggleMic(): void {
    this.toggleMic.emit();
    this.voice.toggleMic().then(() => {
      this.isMicEnabled = this.voice.isMicEnabled;
      this.cdr.markForCheck();
    });
  }

  // --- Chat ---
  onSendChat(): void {
    if (!this.chatText.trim()) return;
    const text = this.chatText.trim();
    this.sendMessage.emit(text);
    this.voice.publishData(
      { type: 'client_action', action: 'text_input', payload: { text } },
      'client_actions',
    );
    this.chatText = '';
  }

  onChatKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.onSendChat();
    }
  }

  // --- UI helpers ---
  get stateLabel(): string {
    switch (this.speakingState) {
      case 'tutor-speaking':
        return 'Tutor speaking';
      case 'user-speaking':
        return "You're speaking";
      case 'ready':
      default:
        return 'Ready';
    }
  }

  get stateDotClass(): string {
    switch (this.speakingState) {
      case 'tutor-speaking':
        return 'dot-amber';
      case 'user-speaking':
        return 'dot-green';
      case 'ready':
      default:
        return 'dot-grey';
    }
  }

  get tutorWaveformAnimated(): boolean {
    return this.speakingState === 'tutor-speaking';
  }

  get userWaveformAnimated(): boolean {
    return this.speakingState === 'user-speaking';
  }

  get pauseButtonLabel(): string {
    return this.isPaused ? 'Resume' : 'Pause';
  }

  getRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);

    if (minutes < 1) return 'now';
    if (minutes === 1) return '1m ago';
    return `${minutes}m ago`;
  }

  getHeatmapColor(value: number): string {
    // 0 = no coverage (dark), 1 = full coverage (amber)
    if (value === 0) return 'var(--ink-60)';
    if (value < 0.3) return 'rgba(232, 164, 39, 0.3)';
    if (value < 0.6) return 'rgba(232, 164, 39, 0.6)';
    return 'var(--amber)';
  }

  trackByMessageId(index: number, message: TranscriptMessage): string {
    return message.id;
  }
}

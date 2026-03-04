import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, Subject, interval, Subscription } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { UserService } from './user.service';

export interface SessionRecord {
  id: string;
  date: string;
  fileName: string;
  transcript: { sender: 'you' | 'agent'; text: string }[];
  topicSummary: string;
}

// API-based session types
export interface TranscriptMessage {
  id: string;
  role: 'tutor' | 'user';
  text: string;
  sectionRef?: string;
  timestamp: number;
  depthDelta?: number;
}

export interface CoverageData {
  coverage: number;
  depth: number;
}

export interface Annotation {
  id: string;
  sectionId: string;
  text: string;
  createdAt: number;
}

export interface QuizResult {
  question: string;
  correct: boolean;
  sectionId: string;
}

export interface LearningSession {
  id: string;
  docId: string;
  startedAt: number;
  endedAt: number | null;
  coverageMap: Record<string, CoverageData>;
  transcript: TranscriptMessage[];
  annotations: Annotation[];
  quizResults: QuizResult[];
}

export interface SessionSummary {
  id: string;
  docId: string;
  startedAt: number;
  endedAt: number | null;
  coverage: number;
  depth: number;
  transcriptCount: number;
  annotationCount: number;
}

const STORAGE_PREFIX = 'learnaloud_sessions_';

@Injectable({ providedIn: 'root' })
export class SessionService implements OnDestroy {
  private readonly apiBase = '/api';
  private destroy$ = new Subject<void>();
  private autoSaveSubscription: Subscription | null = null;

  // Progress observables (polled from /api/sessions/:id/summary)
  coverage$ = new BehaviorSubject<number>(0);
  depth$ = new BehaviorSubject<number>(0);
  private pollInterval: any = null;

  // Current active session state
  private activeSessionId: string | null = null;
  private pendingTranscript: TranscriptMessage[] = [];
  private pendingCoverageMap: Record<string, CoverageData> = {};
  private pendingAnnotations: Annotation[] = [];
  private pendingQuizResults: QuizResult[] = [];

  constructor(
    private userService: UserService,
    private http: HttpClient,
  ) {}

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.stopAutoSave();
  }

  // =========================================================================
  // API-based Learning Session Methods
  // =========================================================================

  /**
   * Start a new learning session - call this when session begins
   */
  startLearningSession(docId: string): Observable<LearningSession> {
    const payload = {
      docId,
      coverageMap: {},
      transcript: [],
      annotations: [],
      quizResults: [],
    };

    return new Observable((observer) => {
      this.http.post<LearningSession>(`${this.apiBase}/sessions`, payload).subscribe({
        next: (session) => {
          this.activeSessionId = session.id;
          this.pendingTranscript = [];
          this.pendingCoverageMap = {};
          this.pendingAnnotations = [];
          this.pendingQuizResults = [];

          // Start auto-save every 30 seconds
          this.startAutoSave();

          observer.next(session);
          observer.complete();
        },
        error: (err) => observer.error(err),
      });
    });
  }

  /**
   * Add a transcript message to be saved
   */
  addTranscriptMessage(message: TranscriptMessage): void {
    this.pendingTranscript.push(message);
  }

  /**
   * Update coverage for a section
   */
  updateCoverage(sectionId: string, coverage: number, depth: number): void {
    this.pendingCoverageMap[sectionId] = { coverage, depth };
  }

  /**
   * Add an annotation
   */
  addAnnotation(annotation: Annotation): void {
    this.pendingAnnotations.push(annotation);
  }

  /**
   * Add a quiz result
   */
  addQuizResult(result: QuizResult): void {
    this.pendingQuizResults.push(result);
  }

  /**
   * Flush pending changes to backend
   */
  flushPendingChanges(): Observable<LearningSession | null> {
    if (!this.activeSessionId) {
      return new Observable((observer) => {
        observer.next(null);
        observer.complete();
      });
    }

    const hasPendingChanges =
      this.pendingTranscript.length > 0 ||
      Object.keys(this.pendingCoverageMap).length > 0 ||
      this.pendingAnnotations.length > 0 ||
      this.pendingQuizResults.length > 0;

    if (!hasPendingChanges) {
      return new Observable((observer) => {
        observer.next(null);
        observer.complete();
      });
    }

    const payload: Partial<LearningSession> = {};
    if (this.pendingTranscript.length > 0) {
      payload.transcript = [...this.pendingTranscript];
    }
    if (Object.keys(this.pendingCoverageMap).length > 0) {
      payload.coverageMap = { ...this.pendingCoverageMap };
    }
    if (this.pendingAnnotations.length > 0) {
      payload.annotations = [...this.pendingAnnotations];
    }
    if (this.pendingQuizResults.length > 0) {
      payload.quizResults = [...this.pendingQuizResults];
    }

    return new Observable((observer) => {
      this.http
        .patch<LearningSession>(`${this.apiBase}/sessions/${this.activeSessionId}`, payload)
        .subscribe({
          next: (session) => {
            // Clear pending items that were successfully saved
            this.pendingTranscript = [];
            this.pendingCoverageMap = {};
            this.pendingAnnotations = [];
            this.pendingQuizResults = [];
            observer.next(session);
            observer.complete();
          },
          error: (err) => observer.error(err),
        });
    });
  }

  /**
   * End the current learning session
   */
  endLearningSession(): Observable<LearningSession | null> {
    if (!this.activeSessionId) {
      return new Observable((observer) => {
        observer.next(null);
        observer.complete();
      });
    }

    this.stopAutoSave();

    const payload: Partial<LearningSession> = {
      endedAt: Date.now(),
    };

    // Include any pending changes
    if (this.pendingTranscript.length > 0) {
      payload.transcript = [...this.pendingTranscript];
    }
    if (Object.keys(this.pendingCoverageMap).length > 0) {
      payload.coverageMap = { ...this.pendingCoverageMap };
    }
    if (this.pendingAnnotations.length > 0) {
      payload.annotations = [...this.pendingAnnotations];
    }
    if (this.pendingQuizResults.length > 0) {
      payload.quizResults = [...this.pendingQuizResults];
    }

    return new Observable((observer) => {
      this.http
        .patch<LearningSession>(`${this.apiBase}/sessions/${this.activeSessionId}`, payload)
        .subscribe({
          next: (session) => {
            this.activeSessionId = null;
            this.pendingTranscript = [];
            this.pendingCoverageMap = {};
            this.pendingAnnotations = [];
            this.pendingQuizResults = [];
            observer.next(session);
            observer.complete();
          },
          error: (err) => observer.error(err),
        });
    });
  }

  /**
   * Get sessions for a document
   */
  getSessionsForDocument(docId: string): Observable<{ sessions: SessionSummary[] }> {
    return this.http.get<{ sessions: SessionSummary[] }>(
      `${this.apiBase}/sessions?docId=${docId}`,
    );
  }

  /**
   * Get full session detail
   */
  getSessionDetail(sessionId: string): Observable<LearningSession> {
    return this.http.get<LearningSession>(`${this.apiBase}/sessions/${sessionId}`);
  }

  /**
   * Get current active session ID
   */
  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  startProgressPolling(sessionId: string): void {
    this.stopProgressPolling();
    const fetch = () =>
      this.http.get<any>(`/api/sessions/${sessionId}/summary`).subscribe({
        next: (s) => {
          this.coverage$.next(s.coverage_pct ?? 0);
          this.depth$.next(s.depth_score ?? 0);
        },
        error: () => {},
      });
    fetch(); // immediate fetch on start
    this.pollInterval = setInterval(fetch, 8000);
  }

  stopProgressPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  sendCoverageUpdate(sessionId: string, page: number, text: string, totalPages?: number): void {
    if (!sessionId) return;
    this.http.patch(`/api/sessions/${sessionId}`, {
      coverageUpdate: { page, text: text.substring(0, 100), totalPages }
    }).subscribe({
      next: () => {
        // Refresh progress immediately after backend confirms the update
        this.http.get<any>(`/api/sessions/${sessionId}/summary`).subscribe({
          next: (s) => {
            this.coverage$.next(s.coverage_pct ?? 0);
            this.depth$.next(s.depth_score ?? 0);
          },
          error: () => {},
        });
      },
      error: () => {},
    });
  }

  private startAutoSave(): void {
    this.stopAutoSave();
    this.autoSaveSubscription = interval(30000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.flushPendingChanges().subscribe({
          error: (err) => console.error('Auto-save failed:', err),
        });
      });
  }

  private stopAutoSave(): void {
    if (this.autoSaveSubscription) {
      this.autoSaveSubscription.unsubscribe();
      this.autoSaveSubscription = null;
    }
  }

  // =========================================================================
  // Legacy localStorage-based Methods (keeping for backwards compatibility)
  // =========================================================================

  saveSession(fileName: string, transcript: { sender: 'you' | 'agent'; text: string }[]): void {
    if (!transcript.length) return;

    const record: SessionRecord = {
      id: crypto.randomUUID(),
      date: new Date().toISOString(),
      fileName,
      transcript,
      topicSummary: this.buildSummary(transcript),
    };

    const sessions = this.getSessions();
    sessions.unshift(record);
    this.saveSessions(sessions);
  }

  getSessions(): SessionRecord[] {
    const key = this.storageKey();
    if (!key) return [];
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
      return [];
    }
  }

  getLatestSession(): SessionRecord | null {
    const sessions = this.getSessions();
    return sessions.length > 0 ? sessions[0] : null;
  }

  getLatestSessionForFile(fileName: string): SessionRecord | null {
    const sessions = this.getSessions();
    return sessions.find(s => s.fileName === fileName) || null;
  }

  clearSessions(): void {
    const key = this.storageKey();
    if (key) localStorage.removeItem(key);
  }

  private buildSummary(transcript: { sender: 'you' | 'agent'; text: string }[]): string {
    const agentEntry = transcript.find(e => e.sender === 'agent');
    if (agentEntry) {
      return agentEntry.text.length > 120
        ? agentEntry.text.substring(0, 120) + '...'
        : agentEntry.text;
    }
    const first = transcript[0];
    return first.text.length > 120
      ? first.text.substring(0, 120) + '...'
      : first.text;
  }

  private storageKey(): string | null {
    const email = this.userService.currentUser?.email;
    if (!email) return null;
    return STORAGE_PREFIX + email;
  }

  private saveSessions(sessions: SessionRecord[]): void {
    const key = this.storageKey();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify(sessions));
  }
}

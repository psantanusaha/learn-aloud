import {
  Component,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';

import { HeatmapComponent } from '../components/shared/heatmap/heatmap.component';
import type { HeatmapSection } from '../components/shared/heatmap/heatmap.component';
import { ButtonComponent } from '../components/shared/button/button.component';

export type HistoryTab = 'transcript' | 'annotations' | 'coverage';

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

export interface TranscriptMessage {
  id: string;
  role: 'tutor' | 'user';
  text: string;
  sectionRef?: string;
  timestamp: number;
  depthDelta?: number;
}

export interface Annotation {
  id: string;
  sectionId: string;
  text: string;
  createdAt: number;
}

export interface SessionDetail {
  id: string;
  docId: string;
  startedAt: number;
  endedAt: number | null;
  coverageMap: Record<string, { coverage: number; depth: number }>;
  transcript: TranscriptMessage[];
  annotations: Annotation[];
  quizResults: { question: string; correct: boolean; sectionId: string }[];
}

interface SessionsResponse {
  sessions: SessionSummary[];
}

@Component({
  selector: 'app-history',
  standalone: true,
  imports: [CommonModule, HeatmapComponent, ButtonComponent],
  templateUrl: './history.component.html',
  styleUrl: './history.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryComponent implements OnInit, OnDestroy {
  docId = '';
  sessions: SessionSummary[] = [];
  selectedSession: SessionDetail | null = null;
  selectedSessionId: string | null = null;
  activeTab: HistoryTab = 'transcript';
  isLoadingSessions = true;
  isLoadingDetail = false;

  private subscriptions: Subscription[] = [];
  private readonly apiBase = '/api';

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private http: HttpClient,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    const sub = this.route.paramMap.subscribe((params) => {
      this.docId = params.get('docId') || '';
      if (this.docId) {
        this.loadSessions();
      }
    });
    this.subscriptions.push(sub);
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
  }

  private loadSessions(): void {
    this.isLoadingSessions = true;
    this.cdr.markForCheck();

    const sub = this.http
      .get<SessionsResponse>(`${this.apiBase}/sessions?docId=${this.docId}`)
      .subscribe({
        next: (response) => {
          this.sessions = response.sessions || [];
          this.isLoadingSessions = false;
          // Auto-select first session if available
          if (this.sessions.length > 0) {
            this.selectSession(this.sessions[0].id);
          }
          this.cdr.markForCheck();
        },
        error: (err) => {
          console.error('Failed to load sessions:', err);
          this.sessions = [];
          this.isLoadingSessions = false;
          this.cdr.markForCheck();
        },
      });

    this.subscriptions.push(sub);
  }

  selectSession(sessionId: string): void {
    if (this.selectedSessionId === sessionId) return;

    this.selectedSessionId = sessionId;
    this.isLoadingDetail = true;
    this.cdr.markForCheck();

    const sub = this.http.get<SessionDetail>(`${this.apiBase}/sessions/${sessionId}`).subscribe({
      next: (detail) => {
        this.selectedSession = detail;
        this.isLoadingDetail = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('Failed to load session detail:', err);
        this.selectedSession = null;
        this.isLoadingDetail = false;
        this.cdr.markForCheck();
      },
    });

    this.subscriptions.push(sub);
  }

  setActiveTab(tab: HistoryTab): void {
    this.activeTab = tab;
    this.cdr.markForCheck();
  }

  resumeSession(): void {
    if (this.selectedSessionId) {
      this.router.navigate(['/session', this.docId], {
        queryParams: { resumeFrom: this.selectedSessionId },
      });
    }
  }

  goBack(): void {
    this.router.navigate(['/library']);
  }

  // --- UI Helpers ---

  formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  formatDuration(startedAt: number, endedAt: number | null): string {
    const end = endedAt || Date.now();
    const durationMs = end - startedAt;
    const minutes = Math.floor(durationMs / 60000);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    return `${minutes}m`;
  }

  formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'now';
  }

  getHeatmapSections(): HeatmapSection[] {
    if (!this.selectedSession) return [];

    return Object.entries(this.selectedSession.coverageMap).map(([id, data]) => ({
      id,
      label: id,
      coverage: Math.round(data.coverage * 100),
      depth: Math.round(data.depth * 100),
    }));
  }

  getStripSections(session: SessionSummary): HeatmapSection[] {
    // For strip preview, create 12 dummy sections based on overall coverage/depth
    return Array(12)
      .fill(null)
      .map((_, i) => ({
        id: `seg-${i}`,
        coverage: session.coverage + (Math.random() - 0.5) * 20,
        depth: session.depth + (Math.random() - 0.5) * 20,
      }));
  }

  trackBySessionId(index: number, session: SessionSummary): string {
    return session.id;
  }

  trackByMessageId(index: number, message: TranscriptMessage): string {
    return message.id;
  }

  trackByAnnotationId(index: number, annotation: Annotation): string {
    return annotation.id;
  }

  isFirstSession(index: number): boolean {
    return index === this.sessions.length - 1;
  }
}

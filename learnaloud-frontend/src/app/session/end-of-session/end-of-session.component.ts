import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';

import { HeatmapComponent } from '../../components/shared/heatmap/heatmap.component';
import type { HeatmapSection } from '../../components/shared/heatmap/heatmap.component';
import { ButtonComponent } from '../../components/shared/button/button.component';

export interface QuizResult {
  question: string;
  correct: boolean;
  sectionId: string;
  revisited?: boolean;
}

export interface SessionSummary {
  sessionId: string;
  sectionsCovered: number;
  questionsAsked: number;
  quizScore: number;
  durationMinutes: number;
  quizResults: QuizResult[];
  coverageMap: Record<string, { coverage: number; depth: number }>;
  note: string;
}

@Component({
  selector: 'app-end-of-session',
  standalone: true,
  imports: [CommonModule, HeatmapComponent, ButtonComponent],
  templateUrl: './end-of-session.component.html',
  styleUrl: './end-of-session.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EndOfSessionComponent implements OnInit {
  @Input() sessionId = '';
  @Input() docId = '';
  @Output() continueSession = new EventEmitter<void>();
  @Output() backToLibrary = new EventEmitter<void>();

  summary: SessionSummary | null = null;
  isLoading = true;
  error: string | null = null;

  private readonly apiBase = '/api';

  constructor(
    private http: HttpClient,
    private router: Router,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    if (this.sessionId) {
      this.loadSummary();
    }
  }

  private loadSummary(): void {
    this.isLoading = true;
    this.error = null;
    this.cdr.markForCheck();

    this.http.get<SessionSummary>(`${this.apiBase}/sessions/${this.sessionId}/summary`).subscribe({
      next: (summary) => {
        this.summary = summary;
        this.isLoading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('Failed to load session summary:', err);
        this.error = 'Failed to load session summary';
        this.isLoading = false;
        this.cdr.markForCheck();
      },
    });
  }

  onContinueSession(): void {
    this.continueSession.emit();
  }

  onBackToLibrary(): void {
    this.backToLibrary.emit();
    this.router.navigate(['/library']);
  }

  // --- UI Helpers ---

  get heatmapSections(): HeatmapSection[] {
    if (!this.summary) return [];

    return Object.entries(this.summary.coverageMap).map(([id, data]) => ({
      id,
      label: id,
      coverage: Math.round(data.coverage * 100),
      depth: Math.round(data.depth * 100),
    }));
  }

  get correctCount(): number {
    if (!this.summary) return 0;
    return this.summary.quizResults.filter((q) => q.correct).length;
  }

  get totalQuestions(): number {
    if (!this.summary) return 0;
    return this.summary.quizResults.length;
  }

  formatDuration(minutes: number): string {
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }

  trackByQuestion(index: number, result: QuizResult): string {
    return result.question;
  }
}

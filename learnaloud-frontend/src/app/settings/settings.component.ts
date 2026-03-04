import {
  Component,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { debounceTime, Subject } from 'rxjs';


export type SettingsSection = 'profile' | 'voice' | 'reading' | 'notifications' | 'billing';
export type TutorVoice = 'nova' | 'alloy' | 'echo' | 'fable';
export type QuizFrequency = 'never' | 'occasionally' | 'often';
export type QuizFormat = 'mixed' | 'mc' | 'open';

export interface UserSettings {
  tutorVoice: TutorVoice;
  speakingSpeed: number;
  voiceActivation: boolean;
  quizFrequency: QuizFrequency;
  endOfSessionQuiz: boolean;
  quizFormat: QuizFormat;
  autoPauseOnTabSwitch: boolean;
  highlightColor: string;
  fontSize: string;
  notificationsEnabled: boolean;
  emailDigest: string;
  showOnboarding: boolean;
}

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsComponent implements OnInit, OnDestroy {
  activeSection: SettingsSection = 'voice';
  settings: UserSettings = this.getDefaultSettings();
  isLoading = true;
  isSaving = false;
  saveMessage: string | null = null;

  private subscriptions: Subscription[] = [];
  private saveSubject = new Subject<void>();
  private readonly apiBase = '/api';

  readonly voiceOptions: { value: TutorVoice; label: string }[] = [
    { value: 'nova', label: 'Nova' },
    { value: 'alloy', label: 'Alloy' },
    { value: 'echo', label: 'Echo' },
    { value: 'fable', label: 'Fable' },
  ];

  readonly quizFormatOptions: { value: QuizFormat; label: string }[] = [
    { value: 'mixed', label: 'Mixed' },
    { value: 'mc', label: 'Multiple Choice Only' },
    { value: 'open', label: 'Open-ended Only' },
  ];

  constructor(
    private http: HttpClient,
    private router: Router,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.loadSettings();

    // Initialize showOnboarding from localStorage
    this.settings.showOnboarding = !localStorage.getItem('learnaloud_onboarded');

    // Debounce saves
    const saveSub = this.saveSubject.pipe(debounceTime(500)).subscribe(() => {
      this.saveSettings();
    });
    this.subscriptions.push(saveSub);
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
  }

  private getDefaultSettings(): UserSettings {
    return {
      tutorVoice: 'nova',
      speakingSpeed: 1.0,
      voiceActivation: true,
      quizFrequency: 'occasionally',
      endOfSessionQuiz: true,
      quizFormat: 'mixed',
      autoPauseOnTabSwitch: true,
      highlightColor: 'yellow',
      fontSize: 'medium',
      notificationsEnabled: true,
      emailDigest: 'weekly',
      showOnboarding: true,
    };
  }

  private loadSettings(): void {
    this.isLoading = true;
    this.cdr.markForCheck();

    const sub = this.http.get<UserSettings>(`${this.apiBase}/users/me/settings`).subscribe({
      next: (settings) => {
        this.settings = { ...this.getDefaultSettings(), ...settings };
        this.isLoading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('Failed to load settings:', err);
        this.settings = this.getDefaultSettings();
        this.isLoading = false;
        this.cdr.markForCheck();
      },
    });

    this.subscriptions.push(sub);
  }

  private saveSettings(): void {
    this.isSaving = true;
    this.cdr.markForCheck();

    const sub = this.http.patch<UserSettings>(`${this.apiBase}/users/me/settings`, this.settings).subscribe({
      next: (settings) => {
        this.settings = { ...this.getDefaultSettings(), ...settings };
        this.isSaving = false;
        this.saveMessage = 'Settings saved';
        this.cdr.markForCheck();

        setTimeout(() => {
          this.saveMessage = null;
          this.cdr.markForCheck();
        }, 2000);
      },
      error: (err) => {
        console.error('Failed to save settings:', err);
        this.isSaving = false;
        this.saveMessage = 'Failed to save';
        this.cdr.markForCheck();
      },
    });

    this.subscriptions.push(sub);
  }

  // --- Event handlers ---

  setSection(section: SettingsSection): void {
    this.activeSection = section;
    this.cdr.markForCheck();
  }

  onSettingChange(): void {
    this.saveSubject.next();
  }

  setQuizFrequency(frequency: QuizFrequency): void {
    this.settings.quizFrequency = frequency;
    this.onSettingChange();
  }

  toggleOnboarding(): void {
    this.settings.showOnboarding = !this.settings.showOnboarding;
    // Reset or set the localStorage flag
    if (this.settings.showOnboarding) {
      localStorage.removeItem('learnaloud_onboarded');
    } else {
      localStorage.setItem('learnaloud_onboarded', 'true');
    }
    this.saveSettings();
  }

  goBack(): void {
    this.router.navigate(['/library']);
  }

  // --- UI Helpers ---

  get speedLabel(): string {
    return `${this.settings.speakingSpeed.toFixed(1)}×`;
  }
}

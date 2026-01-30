import { Component, EventEmitter, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { UserService } from '../../services/user.service';

type View = 'landing' | 'auth' | 'onboarding';
type AuthMode = 'signup' | 'login';
type AcademicLevel = 'undergraduate' | 'graduate' | 'phd' | 'postdoc' | 'professional';

@Component({
  selector: 'app-tutorial',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './tutorial.component.html',
  styleUrls: ['./tutorial.component.css']
})
export class TutorialComponent {
  @Output() startApp = new EventEmitter<void>();

  view: View = 'landing';
  authMode: AuthMode = 'signup';
  authError = '';

  authName = '';
  authEmail = '';
  authPassword = '';

  selectedLevel: AcademicLevel | '' = '';
  selectedSubjects: string[] = [];

  academicLevels: { value: AcademicLevel; label: string }[] = [
    { value: 'undergraduate', label: 'Undergraduate' },
    { value: 'graduate', label: 'Graduate' },
    { value: 'phd', label: 'PhD' },
    { value: 'postdoc', label: 'Postdoc' },
    { value: 'professional', label: 'Professional' },
  ];

  subjects = [
    'Machine Learning', 'NLP', 'Computer Vision', 'Mathematics',
    'Physics', 'Biology', 'Chemistry', 'Economics', 'Other',
  ];

  constructor(private userService: UserService) {}

  goToAuth(mode: AuthMode): void {
    this.authMode = mode;
    this.authError = '';
    this.authName = '';
    this.authEmail = '';
    this.authPassword = '';
    this.view = 'auth';
  }

  toggleAuthMode(): void {
    this.authMode = this.authMode === 'signup' ? 'login' : 'signup';
    this.authError = '';
  }

  submitAuth(): void {
    this.authError = '';

    if (this.authMode === 'signup') {
      if (!this.authName.trim() || !this.authEmail.trim() || !this.authPassword.trim()) {
        this.authError = 'All fields are required.';
        return;
      }
      const result = this.userService.signup(this.authName.trim(), this.authEmail.trim(), this.authPassword);
      if (!result.success) {
        this.authError = result.error || 'Signup failed.';
        return;
      }
      this.view = 'onboarding';
    } else {
      if (!this.authEmail.trim() || !this.authPassword.trim()) {
        this.authError = 'Email and password are required.';
        return;
      }
      const result = this.userService.login(this.authEmail.trim(), this.authPassword);
      if (!result.success) {
        this.authError = result.error || 'Login failed.';
        return;
      }
      if (this.userService.isOnboarded()) {
        this.startApp.emit();
      } else {
        this.view = 'onboarding';
      }
    }
  }

  selectLevel(level: AcademicLevel): void {
    this.selectedLevel = level;
  }

  toggleSubject(subject: string): void {
    const idx = this.selectedSubjects.indexOf(subject);
    if (idx === -1) {
      this.selectedSubjects.push(subject);
    } else {
      this.selectedSubjects.splice(idx, 1);
    }
  }

  isSubjectSelected(subject: string): boolean {
    return this.selectedSubjects.includes(subject);
  }

  submitOnboarding(): void {
    if (!this.selectedLevel || this.selectedSubjects.length === 0) return;
    this.userService.updateProfile({
      academicLevel: this.selectedLevel,
      subjects: this.selectedSubjects,
    });
    this.startApp.emit();
  }

  goBack(): void {
    if (this.view === 'auth') {
      this.view = 'landing';
    } else if (this.view === 'onboarding') {
      this.view = 'auth';
    }
  }
}

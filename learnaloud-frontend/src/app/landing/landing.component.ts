import { Component, OnInit, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { GoogleAuthService } from '../services/google-auth.service';
import { UserService } from '../services/user.service';

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [CommonModule, HttpClientModule],
  templateUrl: './landing.component.html',
  styleUrls: ['./landing.component.css']
})
export class LandingComponent implements OnInit, AfterViewInit {
  isUploading = false;
  uploadError = '';

  constructor(
    private router: Router,
    private http: HttpClient,
    private userService: UserService,
    private googleAuth: GoogleAuthService
  ) {}

  get currentUserEmail(): string {
    return this.userService.currentUser?.email || '';
  }

  isLoggedIn(): boolean {
    return this.userService.isLoggedIn();
  }

  goToLibrary(): void {
    this.router.navigate(['/library']);
  }

  logout(): void {
    this.userService.logout();
    window.location.reload();
  }

  ngOnInit(): void {
    this.googleAuth.init();
  }

  ngAfterViewInit(): void {
    this.googleAuth.renderButton('google-signin-btn');
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.uploadFile(input.files[0]);
    }
  }

  triggerFileInput(): void {
    document.getElementById('file-input')?.click();
  }

  clearAll(): void {
    localStorage.clear();
    sessionStorage.clear();
    window.location.reload();
  }

  trySample(): void {
    this.isUploading = true;
    this.http.get('/sample.pdf', { responseType: 'blob' }).subscribe({
      next: (blob) => {
        const file = new File([blob], 'sample.pdf', { type: 'application/pdf' });
        this.uploadFile(file);
      },
      error: () => {
        this.isUploading = false;
        this.uploadError = 'Could not load sample paper.';
      }
    });
  }

  private uploadFile(file: File): void {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      this.uploadError = 'Please upload a PDF file.';
      return;
    }

    this.isUploading = true;
    this.uploadError = '';

    const formData = new FormData();
    formData.append('file', file);

    this.http.post<any>('/api/documents/upload', formData).subscribe({
      next: (res) => {
        this.router.navigate(['/session', res.session_id]);
      },
      error: (err) => {
        this.isUploading = false;
        this.uploadError = err.error?.error || 'Upload failed.';
      }
    });
  }
}

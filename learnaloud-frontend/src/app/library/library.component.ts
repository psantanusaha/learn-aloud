import {
  Component,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { UserService } from '../services/user.service';
import { ButtonComponent } from '../components/shared/button/button.component';

export interface DocumentItem {
  id: string;
  title: string;
  filename: string;
  lastOpened: string;
  progress: number; // 0-100
  totalPages: number;
  currentPage: number;
  sessionCount: number;
  thumbnailUrl?: string;
}

interface DocumentsResponse {
  documents: DocumentItem[];
}

interface UploadResponse {
  session_id: string;
  filename: string;
  total_pages: number;
  title: string;
}

@Component({
  selector: 'app-library',
  standalone: true,
  imports: [CommonModule, RouterModule, ButtonComponent],
  templateUrl: './library.component.html',
  styleUrl: './library.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryComponent implements OnInit, OnDestroy {
  documents: DocumentItem[] = [];
  isLoading = true;
  isUploading = false;
  uploadProgress = 0;
  isDragOver = false;
  userName = 'there';
  uploadError = '';

  private subscriptions: Subscription[] = [];
  private readonly apiBase = '/api';

  constructor(
    private http: HttpClient,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private userService: UserService,
  ) {}

  logout(): void {
    this.userService.logout();
    this.router.navigate(['/landing']);
  }

  ngOnInit(): void {
    this.loadDocuments();
    this.loadUserName();
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
  }

  private loadUserName(): void {
    // Try to get user name from localStorage or API
    const stored = localStorage.getItem('learnaloud_user');
    if (stored) {
      try {
        const user = JSON.parse(stored);
        this.userName = user.name || 'there';
      } catch {
        this.userName = 'there';
      }
    }
  }

  private loadDocuments(): void {
    this.isLoading = true;
    this.cdr.markForCheck();

    const sub = this.http.get<DocumentsResponse>(`${this.apiBase}/documents`).subscribe({
      next: (response) => {
        this.documents = response.documents || [];
        this.isLoading = false;
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('Failed to load documents:', err);
        this.documents = [];
        this.isLoading = false;
        this.cdr.markForCheck();
      },
    });

    this.subscriptions.push(sub);
  }

  // --- Upload handling ---

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = true;
    this.cdr.markForCheck();
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;
    this.cdr.markForCheck();
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver = false;

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.uploadFile(files[0]);
    }
  }

  onFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.uploadFile(input.files[0]);
      input.value = ''; // Reset for re-upload of same file
    }
  }

  triggerFileInput(): void {
    const input = document.getElementById('library-file-input') as HTMLInputElement;
    input?.click();
  }

  loadSamplePdf(): void {
    if (this.isUploading) return;
    fetch('/sample.pdf')
      .then((res) => res.blob())
      .then((blob) => {
        const file = new File([blob], 'sample.pdf', { type: 'application/pdf' });
        this.uploadFile(file);
      })
      .catch((err) => console.error('Failed to load sample PDF:', err));
  }

  private uploadFile(file: File): void {
    this.uploadError = '';

    if (!file.name.toLowerCase().endsWith('.pdf')) {
      this.uploadError = 'Only PDF files are supported.';
      this.cdr.markForCheck();
      return;
    }

    if (file.size > 1 * 1024 * 1024) {
      this.uploadError = `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum size is 1 MB.`;
      this.cdr.markForCheck();
      return;
    }

    this.isUploading = true;
    this.uploadProgress = 0;
    this.cdr.markForCheck();

    const formData = new FormData();
    formData.append('file', file);

    // Simulate progress: fast to 70%, then slow crawl to 99% so it never looks frozen
    const progressInterval = setInterval(() => {
      if (this.uploadProgress < 70) {
        this.uploadProgress += 10;
      } else if (this.uploadProgress < 99) {
        this.uploadProgress += 1;
      }
      this.cdr.markForCheck();
    }, 300);

    const sub = this.http.post<UploadResponse>(`${this.apiBase}/documents/upload`, formData).subscribe({
      next: (response) => {
        clearInterval(progressInterval);
        this.uploadProgress = 100;
        this.isUploading = false;
        this.uploadError = '';
        this.cdr.markForCheck();

        // Navigate to session
        this.router.navigate(['/session', response.session_id]);
      },
      error: (err) => {
        clearInterval(progressInterval);
        this.isUploading = false;
        this.uploadProgress = 0;
        this.uploadError = err?.error?.error || 'Upload failed. Please try again.';
        this.cdr.markForCheck();
      },
    });

    this.subscriptions.push(sub);
  }

  // --- Navigation ---

  openDocument(doc: DocumentItem): void {
    this.router.navigate(['/session', doc.id]);
  }

  viewHistory(doc: DocumentItem, event: Event): void {
    event.stopPropagation();
    this.router.navigate(['/history', doc.id]);
  }

  // --- UI Helpers ---

  get isEmpty(): boolean {
    return !this.isLoading && this.documents.length === 0;
  }

  get hasDocuments(): boolean {
    return !this.isLoading && this.documents.length > 0;
  }

  get inProgressCount(): number {
    return this.documents.filter((d) => d.progress > 0 && d.progress < 100).length;
  }

  get greeting(): string {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }

  get greetingMessage(): string {
    const count = this.inProgressCount;
    if (count === 0) return 'ready to learn something new?';
    if (count === 1) return 'you have 1 document in progress';
    return `you have ${count} documents in progress`;
  }

  formatDate(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  trackByDocId(index: number, doc: DocumentItem): string {
    return doc.id;
  }
}

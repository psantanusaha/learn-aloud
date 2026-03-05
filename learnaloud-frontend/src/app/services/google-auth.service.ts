import { Injectable, NgZone } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from './api.service';
import { UserService } from './user.service';
import { Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class GoogleAuthService {
  private authReady = new Subject<void>();
  authReady$ = this.authReady.asObservable();
  isInitialized = false;

  constructor(
    private api: ApiService,
    private userService: UserService,
    private router: Router,
    private ngZone: NgZone
  ) {}

  init(): void {
    if (this.isInitialized) return;
    
    const clientId = (window as any).GOOGLE_CLIENT_ID;
    if (!clientId || !(window as any).google) {
      setTimeout(() => this.init(), 1000);
      return;
    }

    (window as any).google.accounts.id.initialize({
      client_id: clientId,
      callback: (response: any) => {
        this.ngZone.run(() => this.handleCredentialResponse(response));
      },
      auto_select: false
    });

    this.isInitialized = true;
    this.authReady.next();
  }

  renderButton(elementId: string): void {
    const el = document.getElementById(elementId);
    if (!el) return;

    if (!this.isInitialized) {
      this.authReady$.subscribe(() => this.renderButton(elementId));
      return;
    }

    (window as any).google.accounts.id.renderButton(el, {
      theme: 'outline',
      size: 'large',
      text: 'continue_with',
      shape: 'pill',
      width: 280
    });
  }

  private handleCredentialResponse(response: any): void {
    this.api.googleSignin(response.credential).subscribe({
      next: (res: any) => {
        this.ngZone.run(() => {
          if (res.token) {
            localStorage.setItem('learnaloud_token', res.token);
            localStorage.setItem('learnaloud_user', JSON.stringify(res.user));
            // Sync with local userService
            this.userService.login(res.user.email, 'google-oauth-managed'); 
            this.router.navigate(['/library']);
          }
        });
      },
      error: (err) => {
        this.ngZone.run(() => {
          console.error('Google Sign-In failed:', err);
        });
      }
    });
  }
}

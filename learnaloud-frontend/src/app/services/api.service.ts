import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, timeout, catchError, throwError } from 'rxjs';
import { io, Socket } from 'socket.io-client';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private socket: Socket | null = null;
  private readonly baseUrl = '/api';

  constructor(private http: HttpClient) {}

  // ---- REST -----------------------------------------------------------------

  uploadPDF(file: File): Observable<any> {
    const formData = new FormData();
    formData.append('file', file);
    return this.http.post(`${this.baseUrl}/upload-pdf`, formData).pipe(
      timeout(60000), // 60 second timeout
      catchError((error) => {
        if (error.name === 'TimeoutError') {
          return throwError(() => ({ status: 0, message: 'Request timeout. The server took too long to respond.' }));
        }
        return throwError(() => error);
      })
    );
  }

  searchText(sessionId: string, text: string, page: number): Observable<any> {
    return this.http.post(`${this.baseUrl}/search-text`, {
      session_id: sessionId,
      text,
      page,
    });
  }

  getVoiceToken(participant: string = 'student'): Observable<any> {
    return this.http.post(`${this.baseUrl}/voice-token`, { participant });
  }

  getDebateTokens(participant: string = 'student'): Observable<any> {
    return this.http.post(`${this.baseUrl}/debate-tokens`, { participant });
  }

  getPdfUrl(sessionId: string): string {
    return `${this.baseUrl}/pdf/${sessionId}`;
  }

  getPaperContext(sessionId: string): Observable<any> {
    return this.http.get(`${this.baseUrl}/paper-context/${sessionId}`);
  }

  getSessionState(sessionId: string): Observable<any> {
    return this.http.get(`${this.baseUrl}/session/${sessionId}/state`);
  }

  updateSessionState(sessionId: string, state: any): Observable<any> {
    return this.http.post(`${this.baseUrl}/session/${sessionId}/state`, state);
  }

  getTunnelUrl(): Observable<any> {
    return this.http.get(`${this.baseUrl}/tunnel-url`);
  }

  // ---- WebSocket (Socket.IO) ------------------------------------------------

  connectSocket(): void {
    if (this.socket?.connected) return;
    this.socket = io(window.location.origin, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
    });
  }

  onConnect(callback: () => void): void {
    this.socket?.on('connect', callback);
  }

  onClientAction(callback: (action: any) => void): void {
    this.socket?.on('client_action', callback);
  }

  onDemoStarted(callback: (data: any) => void): void {
    this.socket?.on('demo_started', callback);
  }

  onDemoFinished(callback: (data: any) => void): void {
    this.socket?.on('demo_finished', callback);
  }

  startDemo(sessionId: string): void {
    this.socket?.emit('start_demo', { session_id: sessionId });
  }

  disconnectSocket(): void {
    this.socket?.disconnect();
    this.socket = null;
  }
}

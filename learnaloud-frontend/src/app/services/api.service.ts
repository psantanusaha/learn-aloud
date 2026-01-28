import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
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
    return this.http.post(`${this.baseUrl}/upload-pdf`, formData);
  }

  searchText(sessionId: string, text: string, page: number): Observable<any> {
    return this.http.post(`${this.baseUrl}/search-text`, {
      session_id: sessionId,
      text,
      page,
    });
  }

  getVoiceToken(participant: string = 'student', sessionId: string = ''): Observable<any> {
    const params: any = { participant };
    if (sessionId) params.session_id = sessionId;
    return this.http.get(`${this.baseUrl}/voice-token`, { params });
  }

  getPdfUrl(sessionId: string): string {
    return `${this.baseUrl}/pdf/${sessionId}`;
  }

  // ---- WebSocket (Socket.IO) ------------------------------------------------

  connectSocket(): void {
    if (this.socket?.connected) return;
    this.socket = io('http://localhost:5000', {
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

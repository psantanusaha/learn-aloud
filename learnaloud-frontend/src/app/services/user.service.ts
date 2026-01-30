import { Injectable } from '@angular/core';

export interface UserProfile {
  name: string;
  email: string;
  password: string;
  academicLevel: 'undergraduate' | 'graduate' | 'phd' | 'postdoc' | 'professional' | '';
  subjects: string[];
  onboarded: boolean;
}

const USERS_KEY = 'learnaloud_users';
const CURRENT_USER_KEY = 'learnaloud_current_user';

@Injectable({ providedIn: 'root' })
export class UserService {
  currentUser: UserProfile | null = null;

  constructor() {
    this.loadCurrentUser();
  }

  signup(name: string, email: string, password: string): { success: boolean; error?: string } {
    const users = this.getUsers();
    if (users.find(u => u.email === email)) {
      return { success: false, error: 'An account with this email already exists.' };
    }
    const user: UserProfile = {
      name,
      email,
      password,
      academicLevel: '',
      subjects: [],
      onboarded: false,
    };
    users.push(user);
    this.saveUsers(users);
    this.currentUser = user;
    localStorage.setItem(CURRENT_USER_KEY, email);
    return { success: true };
  }

  login(email: string, password: string): { success: boolean; error?: string } {
    const users = this.getUsers();
    const user = users.find(u => u.email === email && u.password === password);
    if (!user) {
      return { success: false, error: 'Invalid email or password.' };
    }
    this.currentUser = user;
    localStorage.setItem(CURRENT_USER_KEY, email);
    return { success: true };
  }

  logout(): void {
    this.currentUser = null;
    localStorage.removeItem(CURRENT_USER_KEY);
  }

  updateProfile(data: { academicLevel: UserProfile['academicLevel']; subjects: string[] }): void {
    if (!this.currentUser) return;
    this.currentUser.academicLevel = data.academicLevel;
    this.currentUser.subjects = data.subjects;
    this.currentUser.onboarded = true;

    const users = this.getUsers();
    const idx = users.findIndex(u => u.email === this.currentUser!.email);
    if (idx !== -1) {
      users[idx] = { ...this.currentUser };
      this.saveUsers(users);
    }
  }

  isLoggedIn(): boolean {
    return this.currentUser !== null;
  }

  isOnboarded(): boolean {
    return this.currentUser?.onboarded === true;
  }

  private loadCurrentUser(): void {
    const email = localStorage.getItem(CURRENT_USER_KEY);
    if (!email) return;
    const users = this.getUsers();
    const user = users.find(u => u.email === email);
    if (user) {
      this.currentUser = user;
    } else {
      localStorage.removeItem(CURRENT_USER_KEY);
    }
  }

  private getUsers(): UserProfile[] {
    try {
      return JSON.parse(localStorage.getItem(USERS_KEY) || '[]');
    } catch {
      return [];
    }
  }

  private saveUsers(users: UserProfile[]): void {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  }
}

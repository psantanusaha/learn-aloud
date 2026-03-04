import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'library', pathMatch: 'full' },
  {
    path: 'library',
    loadComponent: () =>
      import('./library/library.component').then((m) => m.LibraryComponent),
  },
  {
    path: 'session/:sessionId',
    loadComponent: () =>
      import('./session-view/session-view.component').then(
        (m) => m.SessionViewComponent,
      ),
  },
  {
    path: 'history/:docId',
    loadComponent: () =>
      import('./history/history.component').then((m) => m.HistoryComponent),
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./settings/settings.component').then((m) => m.SettingsComponent),
  },
  {
    path: 'activity-monitor',
    loadComponent: () =>
      import('./components/activity-monitor/activity-monitor.component').then(
        (m) => m.ActivityMonitorComponent,
      ),
  },
  {
    path: 'dashboard',
    loadComponent: () =>
      import('./components/dashboard/dashboard.component').then(
        (m) => m.DashboardComponent,
      ),
  },
];

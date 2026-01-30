import { Routes } from '@angular/router';

export const routes: Routes = [
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

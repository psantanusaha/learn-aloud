import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { Action } from '../actions';

@Injectable({
  providedIn: 'root'
})
export class ActionService {
  private actionSource = new Subject<Action>();

  action$ = this.actionSource.asObservable();

  dispatch(action: Action) {
    this.actionSource.next(action);
  }
}

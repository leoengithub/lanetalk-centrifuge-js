import EventEmitter from 'events';
import { Centrifuge } from './centrifuge';
import { errorCodes, unsubscribedCodes, subscribingCodes, connectingCodes } from './codes';
import {
  State, SubscriptionEvents, SubscriptionOptions,
  SubscriptionState, TypedEventEmitter,
  SubscriptionDataContext
} from './types';
import { ttlMilliseconds, backoff } from './utils';

/** Subscription to a channel */
export class Subscription extends (EventEmitter as new () => TypedEventEmitter<SubscriptionEvents>) {
  channel: string;
  state: SubscriptionState;

  private _centrifuge: Centrifuge;
  private _promises: Record<number, any>;
  private _resubscribeTimeout?: null | ReturnType<typeof setTimeout> = null;
  private _refreshTimeout?: null | ReturnType<typeof setTimeout> = null;
  private _minResubscribeDelay: number;
  private _maxResubscribeDelay: number;
  private _resubscribeAttempts: number;
  private _promiseId: number;

  private _data: any | null;
  private _getData: null | ((ctx: SubscriptionDataContext) => Promise<any>);
  private _recoverable: boolean;
  private _positioned: boolean;
  private _joinLeave: boolean;
  // @ts-ignore – this is used by a client in centrifuge.ts.
  private _inflight: boolean;

  /** Subscription constructor should not be used directly, create subscriptions using Client method. */
  constructor(centrifuge: Centrifuge, channel: string, options?: Partial<SubscriptionOptions>) {
    super();
    this.channel = channel;
    this.state = SubscriptionState.Unsubscribed;
    this._centrifuge = centrifuge;
    this._data = null;
    this._getData = null;
    this._recoverable = false;
    this._positioned = false;
    this._joinLeave = false;
    this._minResubscribeDelay = 500;
    this._maxResubscribeDelay = 20000;
    this._resubscribeTimeout = null;
    this._resubscribeAttempts = 0;
    this._promises = {};
    this._promiseId = 0;
    this._inflight = false;
    this._refreshTimeout = null;
    this._setOptions(options);
    // @ts-ignore – we are hiding some symbols from public API autocompletion.
    if (this._centrifuge._debugEnabled) {
      this.on('state', (ctx) => {
        // @ts-ignore – we are hiding some symbols from public API autocompletion.
        this._centrifuge._debug('subscription state', channel, ctx.oldState, '->', ctx.newState);
      });
      this.on('error', (ctx) => {
        // @ts-ignore – we are hiding some symbols from public API autocompletion.
        this._centrifuge._debug('subscription error', channel, ctx);
      });
    } else {
      // Avoid unhandled exception in EventEmitter for non-set error handler.
      this.on('error', function () { Function.prototype(); });
    }
  }

  /** ready returns a Promise which resolves upon subscription goes to Subscribed 
   * state and rejects in case of subscription goes to Unsubscribed state. 
   * Optional timeout can be passed.*/
  ready(timeout?: number): Promise<void> {
    if (this.state === SubscriptionState.Unsubscribed) {
      return Promise.reject({ code: errorCodes.subscriptionUnsubscribed, message: this.state });
    }
    if (this.state === SubscriptionState.Subscribed) {
      return Promise.resolve();
    }
    return new Promise((res, rej) => {
      const ctx: any = {
        resolve: res,
        reject: rej
      };
      if (timeout) {
        ctx.timeout = setTimeout(function () {
          rej({ code: errorCodes.timeout, message: 'timeout' });
        }, timeout);
      }
      this._promises[this._nextPromiseId()] = ctx;
    });
  }

  /** subscribe to a channel.*/
  subscribe() {
    if (this._isSubscribed()) {
      return;
    }
    this._resubscribeAttempts = 0;
    this._setSubscribing(subscribingCodes.subscribeCalled, 'subscribe called');
  }

  /** unsubscribe from a channel, keeping position state.*/
  unsubscribe() {
    this._setUnsubscribed(unsubscribedCodes.unsubscribeCalled, 'unsubscribe called', true);
  }

  private _nextPromiseId() {
    return ++this._promiseId;
  }

  private _isUnsubscribed() {
    return this.state === SubscriptionState.Unsubscribed;
  }

  private _isSubscribing() {
    return this.state === SubscriptionState.Subscribing;
  }

  private _isSubscribed() {
    return this.state === SubscriptionState.Subscribed;
  }

  private _setState(newState: SubscriptionState) {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      this.emit('state', { newState, oldState, channel: this.channel });
      return true;
    }
    return false;
  }

  private _clearSubscribingState() {
    this._resubscribeAttempts = 0;
    this._clearResubscribeTimeout();
  }

  private _clearSubscribedState() {
    this._clearRefreshTimeout();
  }

  private _setSubscribed(result: any) {
    if (!this._isSubscribing()) {
      return;
    }
    this._clearSubscribingState();

    this._setState(SubscriptionState.Subscribed);
    // @ts-ignore – we are hiding some methods from public API autocompletion.
    const ctx = this._centrifuge._getSubscribeContext(this.channel, result);
    this.emit('subscribed', ctx);
    this._resolvePromises();

    const pubs = result.publications;
    if (pubs && pubs.length > 0) {
      for (const i in pubs) {
        if (!pubs.hasOwnProperty(i)) {
          continue;
        }
        this._handlePublication(pubs[i]);
      }
    }

    if (result.expires === true) {
      this._refreshTimeout = setTimeout(() => this._refresh(), ttlMilliseconds(result.ttl));
    }
  }

  private _setSubscribing(code: number, reason: string) {
    if (this._isSubscribing()) {
      return;
    }
    if (this._isSubscribed()) {
      this._clearSubscribedState();
    }
    if (this._setState(SubscriptionState.Subscribing)) {
      this.emit('subscribing', { channel: this.channel, code: code, reason: reason });
    }
    this._subscribe();
  }

  private _subscribe(): any {
    // @ts-ignore – we are hiding some symbols from public API autocompletion.
    this._centrifuge._debug('subscribing on', this.channel);

    // need to check transport readiness here, because there's no point for calling getData or getToken
    // if transport is not ready yet
    // @ts-ignore – we are hiding some symbols from public API autocompletion.
    if (!this._centrifuge._transportIsOpen) {
      // @ts-ignore – we are hiding some symbols from public API autocompletion.
      this._centrifuge._debug('delay subscribe on', this.channel, 'till connected');
      // subscribe will be called later automatically.
      return null;
    }

    const self = this;
    const getDataCtx = {
      channel: self.channel
    };

    if (self._getData) {
      self._getData(getDataCtx).then(function (data: any) {
        if (!self._isSubscribing()) {
          return;
        }
        self._data = data;
        self._sendSubscribe();
      })
      return null;
    } else {
      return self._sendSubscribe();
    }
  }

  private _sendSubscribe(): any {
    // we also need to check for transport state before sending subscription
    // because it may change for subscription with side effects (getData, getToken options)
    // @ts-ignore – we are hiding some symbols from public API autocompletion.
    if (!this._centrifuge._transportIsOpen) {
      return null;
    }
    const channel = this.channel;

    const req: any = {
      channel: channel
    };

    if (this._data) {
      req.data = this._data;
    }

    if (this._positioned) {
      req.positioned = true;
    }

    if (this._recoverable) {
      req.recoverable = true;
    }

    if (this._joinLeave) {
      req.join_leave = true;
    }

    const cmd = { subscribe: req };

    this._inflight = true;

    // @ts-ignore – we are hiding some symbols from public API autocompletion.
    this._centrifuge._call(cmd).then(resolveCtx => {
      this._inflight = false;
      // @ts-ignore - improve later.
      const result = resolveCtx.reply.result;
      this._handleSubscribeResponse(result);
      // @ts-ignore - improve later.
      if (resolveCtx.next) {
        // @ts-ignore - improve later.
        resolveCtx.next();
      }
    }, rejectCtx => {
      this._inflight = false;
      this._handleSubscribeError(rejectCtx.error);
      if (rejectCtx.next) {
        rejectCtx.next();
      }
    });
    return cmd;
  }

  private _handleSubscribeError(error) {
    if (!this._isSubscribing()) {
      return;
    }
    if (error.code === errorCodes.timeout) {
      // @ts-ignore – we are hiding some symbols from public API autocompletion.
      this._centrifuge._disconnect(connectingCodes.subscribeTimeout, 'subscribe timeout', true);
      return;
    }
    this._subscribeError(error);
  }

  private _handleSubscribeResponse(result) {
    if (!this._isSubscribing()) {
      return;
    }
    this._setSubscribed(result);
  }

  private _setUnsubscribed(code, reason, sendUnsubscribe) {
    if (this._isUnsubscribed()) {
      return;
    }
    if (this._isSubscribed()) {
      if (sendUnsubscribe) {
        // @ts-ignore – we are hiding some methods from public API autocompletion.
        this._centrifuge._unsubscribe(this);
      }
      this._clearSubscribedState();
    }
    if (this._isSubscribing()) {
      if (this._inflight && sendUnsubscribe) {
        // @ts-ignore – we are hiding some methods from public API autocompletion.
        this._centrifuge._unsubscribe(this);
      }
      this._clearSubscribingState();
    }
    if (this._setState(SubscriptionState.Unsubscribed)) {
      this.emit('unsubscribed', { channel: this.channel, code: code, reason: reason });
    }
    this._rejectPromises({ code: errorCodes.subscriptionUnsubscribed, message: this.state });
  }

  private _handlePublication(pub: any) {
    this.emit('publication', pub);
  }

  private _resolvePromises() {
    for (const id in this._promises) {
      if (!this._promises.hasOwnProperty(id)) {
        continue;
      }
      if (this._promises[id].timeout) {
        clearTimeout(this._promises[id].timeout);
      }
      this._promises[id].resolve();
      delete this._promises[id];
    }
  }

  private _rejectPromises(err: any) {
    for (const id in this._promises) {
      if (!this._promises.hasOwnProperty(id)) {
        continue;
      }
      if (this._promises[id].timeout) {
        clearTimeout(this._promises[id].timeout);
      }
      this._promises[id].reject(err);
      delete this._promises[id];
    }
  }

  private _scheduleResubscribe() {
    const self = this;
    const delay = this._getResubscribeDelay();
    this._resubscribeTimeout = setTimeout(function () {
      if (self._isSubscribing()) {
        self._subscribe();
      }
    }, delay);
  }

  private _subscribeError(err: any) {
    if (!this._isSubscribing()) {
      return;
    }
    if (err.code < 100 || err.code === 109 || err.temporary === true) {
      const errContext = {
        channel: this.channel,
        type: 'subscribe',
        error: err
      };
      if (this._centrifuge.state === State.Connected) {
        this.emit('error', errContext);
      }
      this._scheduleResubscribe();
    } else {
      this._setUnsubscribed(err.code, err.message, false);
    }
  }

  private _getResubscribeDelay() {
    const delay = backoff(this._resubscribeAttempts, this._minResubscribeDelay, this._maxResubscribeDelay);
    this._resubscribeAttempts++;
    return delay;
  }

  private _setOptions(options: Partial<SubscriptionOptions> | undefined) {
    if (!options) {
      return;
    }
    if (options.data) {
      this._data = options.data;
    }
    if (options.getData) {
      this._getData = options.getData;
    }
    if (options.minResubscribeDelay !== undefined) {
      this._minResubscribeDelay = options.minResubscribeDelay;
    }
    if (options.maxResubscribeDelay !== undefined) {
      this._maxResubscribeDelay = options.maxResubscribeDelay;
    }
    if (options.positioned === true) {
      this._positioned = true;
    }
    if (options.recoverable === true) {
      this._recoverable = true;
    }
    if (options.joinLeave === true) {
      this._joinLeave = true;
    }
  }

  private _clearRefreshTimeout() {
    if (this._refreshTimeout !== null) {
      clearTimeout(this._refreshTimeout);
      this._refreshTimeout = null;
    }
  }

  private _clearResubscribeTimeout() {
    if (this._resubscribeTimeout !== null) {
      clearTimeout(this._resubscribeTimeout);
      this._resubscribeTimeout = null;
    }
  }

  private _refresh() {
    this._clearRefreshTimeout();
  }
}

// Permission requests for DeviceMotionEvent / DeviceOrientationEvent.
//
// iOS Safari only grants these when requestPermission() is called directly
// from a user gesture (e.g. a button's click handler). Therefore this
// function calls requestPermission() synchronously, before any await or
// timer: the caller must call it inside the click handler itself.

import { STATUS, makeResult } from './result.js';

export function requestEventPermission({ env, kind, EventClass, what }) {
  const done = (status, value, detail) =>
    makeResult({ kind, status, value, observedAtMs: env.now(), source: env.source, detail });

  if (env.isSecureContext === false) {
    return Promise.resolve(
      done(STATUS.INSECURE, null, `HTTPS ではない画面のため、${what}の許可を求められません。`),
    );
  }
  if (typeof EventClass === 'undefined' || EventClass === null) {
    return Promise.resolve(done(STATUS.UNSUPPORTED, null, `この端末・ブラウザは${what}に対応していません。`));
  }
  if (typeof EventClass.requestPermission !== 'function') {
    return Promise.resolve(
      done(STATUS.OK, { permission: 'not_required' }, `この端末・ブラウザでは${what}の許可を求める操作は要りません。`),
    );
  }

  let pending;
  try {
    pending = EventClass.requestPermission(); // must stay synchronous (see above)
  } catch (err) {
    return Promise.resolve(errorResult(err));
  }
  return Promise.resolve(pending).then(
    (answer) => {
      if (answer === 'granted') return done(STATUS.OK, { permission: 'granted' }, `${what}の利用が許可されました。`);
      if (answer === 'denied') {
        return done(
          STATUS.DENIED,
          null,
          `${what}の利用が許可されませんでした。もう一度求めるには、ブラウザを開き直すか、端末やブラウザの設定を変える必要がある場合があります。`,
        );
      }
      if (answer === 'prompt') {
        return done(
          STATUS.UNKNOWN,
          null,
          `${what}はまだ許可されていません（許可を求める画面が出ませんでした）。ボタンを押してもう一度求めてください。`,
        );
      }
      return done(STATUS.UNKNOWN, null, `${what}の許可の結果が分かりませんでした（${String(answer)}）。`);
    },
    (err) => errorResult(err),
  );

  function errorResult(err) {
    if (err?.name === 'NotAllowedError') {
      return done(
        STATUS.ERROR,
        null,
        `${what}の許可を求められませんでした。ボタンを押したときの処理から直接呼んでください。`,
      );
    }
    return done(STATUS.ERROR, null, `${what}の許可を求める途中でエラーが起きました。`);
  }
}

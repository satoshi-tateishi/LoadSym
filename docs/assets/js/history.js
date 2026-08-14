// Undo / Redo。
//
// 差分ではなく状態のスナップショットを積む。連鎖押し出しは1回の操作で多数の
// 機材が動くため、差分を組み立てるより丸ごと控えるほうが単純で間違いが少ない。
// 機材点数はせいぜい数十なので、深さ50でもメモリは問題にならない。

const MAX_DEPTH = 50;

export function createHistory(initialState) {
  let past = [];
  let present = clone(initialState);
  let future = [];

  return {
    /** 現在の状態。呼び出し側はこれを描画する。 */
    get current() {
      return present;
    },

    get canUndo() {
      return past.length > 0;
    },

    get canRedo() {
      return future.length > 0;
    },

    /**
     * 操作後の状態を記録する。ここを呼んだ時点でRedo履歴は捨てる
     * （分岐した履歴を保持しても使い道がなく、挙動が読みにくくなるため）。
     */
    commit(nextState) {
      past.push(present);
      if (past.length > MAX_DEPTH) past.shift();
      present = clone(nextState);
      future = [];
      return present;
    },

    /** 履歴に積まずに現在の状態を差し替える（読み込み直後など）。 */
    reset(state) {
      past = [];
      present = clone(state);
      future = [];
      return present;
    },

    undo() {
      if (past.length === 0) return present;
      future.unshift(present);
      present = past.pop();
      return present;
    },

    redo() {
      if (future.length === 0) return present;
      past.push(present);
      present = future.shift();
      return present;
    }
  };
}

// structuredCloneは配置データ（プレーンなオブジェクトと配列のみ）に十分。
// Alpineのプロキシが混ざると複製できないため、呼び出し側は生の値を渡すこと。
function clone(state) {
  return structuredClone(state);
}

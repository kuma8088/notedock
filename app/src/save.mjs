import { mergeText } from './merge.mjs'

export const SAVE_DELAY_MS = 2000
const RETRY_MS = 3000
const DRAFT_GAP_MS = 1000

// 保存と外部変更の取り込みを担当する。画面には doc（読み書き）と status（知らせ）だけを通して触る。
export function createSaver({ doc, api, path, baseText, baseHash, onStatus, drafts, delay = SAVE_DELAY_MS, retry = RETRY_MS, schedule = setTimeout, cancel = clearTimeout }) {
  let base = baseText
  let hash = baseHash
  let timer = null
  let saving = false
  let savingText = null
  let again = false
  let stopped = null
  let conflictTheirs = null
  let pendingExternal = null
  let closed = false
  let inFlight = null
  let lastDraft = 0

  const status = (state, detail) => onStatus?.({ state, ...detail })
  const dirty = () => doc.get() !== base

  function clearDraft() {
    drafts?.remove(path)
  }

  function keepDraft() {
    if (dirty()) drafts?.set(path, { text: doc.get(), baseText: base, baseHash: hash, time: Date.now() })
  }

  function arm(ms = delay) {
    if (closed) return
    if (timer) cancel(timer)
    timer = schedule(() => {
      timer = null
      save()
    }, ms)
  }

  function changed() {
    // 大きいノートで打つたびに全文を書かないよう、下書きは間を空けて残す。
    if (Date.now() - lastDraft >= DRAFT_GAP_MS) {
      lastDraft = Date.now()
      keepDraft()
    }
    if (stopped) return
    status('dirty')
    arm()
  }

  async function save() {
    if (timer) {
      cancel(timer)
      timer = null
    }
    if (closed || stopped) return
    if (doc.holdSave?.()) {
      arm(500)
      return
    }
    if (saving) {
      again = true
      return
    }
    const text = doc.get()
    if (text === base) {
      clearDraft()
      status('saved')
      return
    }
    saving = true
    savingText = text
    status('saving')
    try {
      inFlight = api.write(path, text, hash)
      const result = await inFlight
      saving = false
      if (result.conflict) {
        // 閉じたときに最新の入力を下書きにしてあるので、古い内容で上書きしない。
        if (closed) return
        applyExternal(result.current, result.hash)
        // 編集中で取り込みを待っているときは、保存できていないことを見せておく。
        if (pendingExternal) status('dirty')
      } else {
        base = text
        hash = result.hash
        // ノートを切り替えたあとは、画面にあるのは別のノートなので触らない。
        if (closed) {
          if (drafts?.get(path)?.text === text) clearDraft()
          return
        }
        if (doc.get() === base) {
          clearDraft()
          status('saved')
        } else {
          keepDraft()
          arm()
        }
      }
    } catch (error) {
      saving = false
      if (closed) return
      keepDraft()
      if (error.status === 403) {
        blocked()
        return
      }
      if (error.status === 412 || error.status === 401) {
        elsewhere()
        return
      }
      // サーバーが答えた失敗（500など）は、つながらないのとは違う。
      status(typeof error.status === 'number' ? 'save-failed' : 'offline', { message: error.message })
      arm(retry)
      return
    }
    if (again) {
      again = false
      save()
    }
  }

  function applyExternal(theirs, theirsHash) {
    if (closed) return
    // 自分の保存の知らせが、保存の返事より先に届いた。取り込むと、そのあとの取り消しや削除が戻ってしまう。
    if (saving && theirs === savingText) return
    if (doc.composing?.()) {
      pendingExternal = { theirs, theirsHash }
      return
    }
    if (stopped === 'elsewhere') return
    // ファイルが戻ってきたら、止めていた保存を再開する。
    const resumed = stopped === 'removed' || stopped === 'blocked'
    if (resumed) stopped = null
    if (theirsHash === hash && theirs === base) {
      if (resumed && dirty()) {
        status('dirty')
        arm(0)
      } else if (resumed) {
        status('saved')
      }
      return
    }
    const mine = doc.get()
    if (mine === theirs) {
      base = theirs
      hash = theirsHash
      clearDraft()
      status('saved')
      return
    }
    if (stopped === 'conflict') {
      conflictTheirs = { text: theirs, hash: theirsHash }
      status('conflict', { theirs })
      return
    }
    const merged = mergeText(base, mine, theirs)
    if (merged.conflict) {
      if (timer) {
        cancel(timer)
        timer = null
      }
      stopped = 'conflict'
      conflictTheirs = { text: theirs, hash: theirsHash }
      api.backup(path, mine).catch(() => {})
      keepDraft()
      status('conflict', { theirs })
      return
    }
    // ファイルパネルのOverrideなどで消える内容も、戻せるように残す。
    if (merged.text !== mine) api.backup(path, mine).catch(() => {})
    base = theirs
    hash = theirsHash
    if (merged.text !== mine) doc.set(merged.text)
    if (merged.text === theirs) {
      clearDraft()
      status('updated')
    } else {
      keepDraft()
      status('dirty')
      arm(0)
    }
  }

  async function resolve(choice) {
    if (stopped !== 'conflict' || !conflictTheirs) return
    const { text: theirs, hash: theirsHash } = conflictTheirs
    const mine = doc.get()
    conflictTheirs = null
    stopped = null
    base = theirs
    hash = theirsHash
    if (choice === 'theirs') {
      await api.backup(path, mine).catch(() => {})
      if (mine !== theirs) doc.set(theirs)
      clearDraft()
      status('saved')
    } else {
      await api.backup(path, theirs).catch(() => {})
      status('dirty')
      arm(0)
    }
  }

  function removed() {
    if (stopped === 'elsewhere') return
    if (timer) {
      cancel(timer)
      timer = null
    }
    stopped = 'removed'
    api.backup(path, doc.get()).catch(() => {})
    keepDraft()
    status('removed')
  }

  function blocked() {
    if (stopped === 'elsewhere') return
    if (timer) {
      cancel(timer)
      timer = null
    }
    stopped = 'blocked'
    keepDraft()
    status('blocked')
  }

  // タブを開いたあとで、サーバーが別のフォルダーのものに変わった。ここの内容を向こうへ書かない。
  function elsewhere() {
    if (stopped === 'elsewhere') return
    if (timer) {
      cancel(timer)
      timer = null
    }
    stopped = 'elsewhere'
    pendingExternal = null
    keepDraft()
    status('elsewhere')
  }

  function compositionEnded() {
    if (pendingExternal) {
      const { theirs, theirsHash } = pendingExternal
      pendingExternal = null
      applyExternal(theirs, theirsHash)
    }
    if (!stopped && dirty()) arm()
  }

  // ブラウザに残っていた下書きを、今のファイルと合わせて戻す。
  function restoreDraft(draft) {
    if (!draft) return false
    if (draft.text === doc.get()) {
      clearDraft()
      return false
    }
    const merged = mergeText(draft.baseText, draft.text, base)
    if (merged.conflict) {
      doc.set(draft.text)
      stopped = 'conflict'
      conflictTheirs = { text: base, hash }
      status('conflict', { theirs: base })
      return true
    }
    doc.set(merged.text)
    status('dirty')
    arm(0)
    return true
  }

  // バックアップの内容に戻す。戻す前の内容もバックアップに残す。
  async function restore(text) {
    await api.backup(path, doc.get()).catch(() => {})
    doc.set(text)
    if (!stopped) arm(0)
  }

  return {
    restore,
    changed,
    save,
    applyExternal,
    resolve,
    removed,
    compositionEnded,
    restoreDraft,
    blocked,
    elsewhere,
    isStopped: () => stopped,
    // 書きかけがあれば、今の内容ですぐ下書きを書き直す（間を空ける決まりを待たない）。
    keepDraft,
    // ノートを切り替える前に、未保存の内容を保存しきる。保存できなければ下書きに残る。
    async flush() {
      if (saving) await inFlight?.catch(() => {})
      if (!stopped && !closed && dirty()) await save()
    },
    close() {
      keepDraft()
      closed = true
      if (timer) cancel(timer)
    },
  }
}

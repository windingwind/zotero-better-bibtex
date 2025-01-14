/* eslint-disable @typescript-eslint/no-empty-function */

import type { Translators as Translator } from '../typings/translators'
declare const workerEnvironment: any
declare const workerJob: Translator.Worker.Job
declare const dump: (msg: string) => void

import { stringify } from './stringify'
import { asciify } from './text'

export const discard = {
  log(): void {},
  error(): void {},
  warn(): void {},
  debug(): void {},
  info(): void {},
  clear(): void {},
  dir(): void {},
  table(): void {},
}

export function print(msg: string): void {
  dump(`better-bibtex::${msg}\n`)
}

function toString(obj): string {
  try {
    if (typeof obj === 'string') return obj
    return stringify(obj, 0)
  }
  catch (err) {
    return stringify(err, 0)
  }
}

class Logger {
  protected timestamp: number
  public prefix = ''

  private format({ ascii=true, trace=false, error=false }, msg) {
    let diff = ''
    if (trace) {
      const now = Date.now()
      if (this.timestamp) diff = `+${now - this.timestamp} `
      this.timestamp = now
    }

    if (Array.isArray(msg)) msg = msg.map(toString).join(' ')

    let prefix = ''
    if (typeof workerEnvironment !== 'undefined') {
      prefix += ' worker'
      if (typeof workerJob !== 'undefined') prefix += `:${workerJob.translator}`
    }

    if (error) prefix += ' error:'
    if (ascii) msg = asciify(msg)

    return `{better-bibtex${this.prefix}${prefix}} ${diff}${msg}`
  }

  public get enabled(): boolean {
    return (
      (typeof workerJob !== 'undefined' && workerJob.debugEnabled)
      ||
      !Zotero
      ||
      Zotero.Debug?.enabled
      ||
      Zotero.Prefs?.get('debug.store')
    ) as boolean
  }

  public print(msg: string) {
    if (!this.enabled) return

    if (typeof Zotero !== 'undefined') {
      Zotero.debug(msg)
    }
    else {
      print(msg)
    }
  }

  public debug(...msg) {
    this.print(this.format({}, msg))
  }

  public info(msg: string) {
    this.print(this.format({ ascii: false }, msg))
  }

  public trace(msg: string, reset=false) {
    if (reset) this.timestamp = 0
    this.print(this.format({ trace: true, ascii: false }, msg))
  }

  public error(...msg) {
    this.print(this.format({error: true}, msg))
  }

  public status({ error=false }, ...msg) {
    if (error || this.enabled) Zotero.debug(this.format({error}, msg))
  }
}

export const log = new Logger

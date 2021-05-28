import ETA from 'node-eta'

import { kuroshiro } from './key-manager/kuroshiro'
import { jieba } from './key-manager/jieba'

import { Scheduler } from './scheduler'
import { log } from './logger'
import { sleep } from './sleep'
import { flash } from './flash'
import { Events, itemsChanged as notifyItemsChanged } from './events'
import { arXiv } from './arXiv'
import * as Extra from './extra'
import { $and, Query } from './db/loki'

import * as ZoteroDB from './db/zotero'

import { getItemsAsync } from './get-items-async'

import { Preference } from '../gen/preferences'
import { Formatter } from './key-manager/formatter'
import { DB } from './db/main'
import { DB as Cache } from './db/cache'

import { patch as $patch$ } from './monkey-patch'

import { sprintf } from 'sprintf-js'
import { intToExcelCol } from 'excel-column-name'

export class KeyManager {
  public keys: any
  public query: {
    field: { extra?: number }
    type: {
      note?: number
      attachment?: number
      annotation?: number
    }
  }
  public autopin: Scheduler = new Scheduler('autoPinDelay', 1000) // eslint-disable-line no-magic-numbers

  private scanning: any[]
  private started = false

  private async inspireHEP(doi: string, arxiv: string) {
    for (const [type, id] of [['DOI', doi], ['arXiv ID', arxiv]]) {
      if (!id) continue
      const url = type === 'DOI' ? `https://inspirehep.net/api/doi/${id}` : `https://inspirehep.net/api/arxiv/${id}`

      try {
        const results = await (await fetch(url, { method: 'GET', cache: 'no-cache', redirect: 'follow' })).json()

        if (results.status && (results.status < 200 || results.status > 299)) { // eslint-disable-line no-magic-numbers
          flash(`Could not fetch inspireHEP key from ${type}`, `Could not fetch inspireHEP key for ${type} ${JSON.stringify(id)},\n\nInspireHEP says: ${results.message}`)

        }
        else if (results.metadata.texkeys.length === 0) {
          flash(`No inspireHEP key found for ${type}`)

        }
        else {
          if (results.metadata.texkeys.length > 1) {
            flash(`Multiple inspireHEP keys found for ${type}`, `Multiple inspireHEP keys found for ${type} (${results.metadata.texkeys.join(' / ')}), selected ${results.metadata.texkeys[0]}`)
          }
          return (results.metadata.texkeys[0] as string)
        }
      }
      catch (err) {
        flash(`Error fetching inspireHEP key from ${type}`, `Could not fetch inspireHEP key for ${type} ${JSON.stringify(id)}\n\n${err.message}`)
        log.error('inspireHEP', url, err)
      }
    }
    return null
  }

  private getField(item: { getField: ((str: string) => string)}, field: string): string {
    try {
      return item.getField(field) || ''
    }
    catch (err) {
      return ''
    }
  }

  public async set(): Promise<void> {
    const ids = this.expandSelection('selected')
    if (ids.length !== 1) return alert(Zotero.BetterBibTeX.getString('Citekey.set.toomany'))

    Cache.remove(ids, `setting key for ${ids}`)
    const existingKey = this.get(ids[0]).citekey
    const citationKey = prompt(Zotero.BetterBibTeX.getString('Citekey.set.change'), existingKey) || existingKey
    if (citationKey === existingKey) return

    const item = await getItemsAsync(ids[0])
    item.setField('extra', Extra.set(item.getField('extra'), { citationKey }))
    await item.saveTx() // this should cause an update and key registration
  }

  public async pin(ids: 'selected' | number | number[], inspireHEP = false): Promise<void> {
    ids = this.expandSelection(ids)

    for (const item of await getItemsAsync(ids)) {
      if (item.isNote() || item.isAttachment() || item.isAnnotation?.()) continue

      const extra = this.getField(item, 'extra')
      const parsed = Extra.get(extra, 'zotero')
      let citationKey: string = null

      if (inspireHEP) {
        const doi = (this.getField(item, 'DOI') || parsed.extraFields.kv.DOI || '').replace(/^https?:\/\/doi.org\//i, '')
        const arxiv = ((['arxiv.org', 'arxiv'].includes((this.getField(item, 'libraryCatalog') || '').toLowerCase())) && arXiv.parse(this.getField(item, 'publicationTitle')).id) || arXiv.parse(parsed.extraFields.tex.arxiv).id

        if (!doi && !arxiv) continue
        citationKey = await this.inspireHEP(doi, arxiv)
        if (!citationKey) continue

        if (parsed.extraFields.citationKey === citationKey) continue

      }
      else {
        if (parsed.extraFields.citationKey) continue

        citationKey = this.get(item.id).citekey || this.update(item)
      }

      item.setField('extra', Extra.set(extra, { citationKey }))
      await item.saveTx() // this should cause an update and key registration
    }
  }

  public async unpin(ids: 'selected' | number | number[]): Promise<void> {
    ids = this.expandSelection(ids)

    for (const item of await getItemsAsync(ids)) {
      if (item.isNote() || item.isAttachment() || item.isAnnotation?.()) continue

      const parsed = Extra.get(item.getField('extra'), 'zotero', { citationKey: true })
      if (!parsed.extraFields.citationKey) continue

      item.setField('extra', parsed.extra) // citekey is stripped here but will be regenerated by the notifier
      item.saveTx()
    }

  }

  public async refresh(ids: 'selected' | number | number[], manual = false): Promise<void> {
    ids = this.expandSelection(ids)

    Cache.remove(ids, `refreshing keys for ${ids}`)

    const warnAt = manual ? Preference.warnBulkModify : 0
    if (warnAt > 0 && ids.length > warnAt) {
      const affected = this.keys.find({ $and: [{ itemID: { $in: ids } }, { pinned: { $eq: false } } ] }).length
      if (affected > warnAt) {
        const params = { treshold: warnAt, response: null }
        Zotero.BetterBibTeX.openDialog('chrome://zotero-better-bibtex/content/bulk-keys-confirm.xul', '', 'chrome,dialog,centerscreen,modal', params)
        switch (params.response) {
          case 'ok':
            break
          case 'whatever':
            Preference.warnBulkModify = 0
            break
          default:
            return
        }
      }
    }

    const updates = []
    for (const item of await getItemsAsync(ids)) {
      if (item.isNote() || item.isAttachment() || item.isAnnotation?.()) continue

      const extra = item.getField('extra')

      let citekey = Extra.get(extra, 'zotero', { citationKey: true }).extraFields.citationKey
      if (citekey) continue // pinned, leave it alone

      this.update(item)

      // remove the new citekey from the aliases if present
      citekey = this.get(item.id).citekey
      const aliases = Extra.get(extra, 'zotero', { aliases: true })
      if (aliases.extraFields.aliases.includes(citekey)) {
        aliases.extraFields.aliases = aliases.extraFields.aliases.filter(alias => alias !== citekey)

        if (aliases.extraFields.aliases.length) {
          item.setField('extra', Extra.set(aliases.extra, { aliases: aliases.extraFields.aliases }))
        }
        else {
          item.setField('extra', aliases.extra)
        }
        await item.saveTx()
      }
      else {
        updates.push(item)
      }
    }

    if (updates.length) notifyItemsChanged(updates)
  }

  public async init(): Promise<void> {
    await kuroshiro.init()
    jieba.init()

    this.keys = DB.getCollection('citekey')

    this.query = {
      field: {},
      type: {},
    }

    for (const type of await ZoteroDB.queryAsync('select itemTypeID, typeName from itemTypes')) { // 1 = attachment, 14 = note
      this.query.type[type.typeName] = type.itemTypeID
    }

    for (const field of await ZoteroDB.queryAsync('select fieldID, fieldName from fields')) {
      this.query.field[field.fieldName] = field.fieldID
    }

    Formatter.update('init')
  }

  public async start(): Promise<void> {
    await this.rescan()

    if (Preference.citekeySearch) {
      const path = OS.Path.join(Zotero.DataDirectory.dir, 'better-bibtex-search.sqlite')
      await Zotero.DB.queryAsync(`ATTACH DATABASE '${path.replace(/'/g, "''")}' AS betterbibtexsearch`)
      await Zotero.DB.queryAsync('CREATE TABLE IF NOT EXISTS betterbibtexsearch.citekeys (itemID PRIMARY KEY, itemKey UNIQUE, citekey)')

      const match: Record<string, { itemID: number, itemKey: string, citekey: string }> = this.keys.data
        .reduce((acc: Record<string, { itemID: number, itemKey: string, citekey: string }>, k) => { acc[`${k.itemID}\t${k.itemKey}\t${k.citekey}`] = k; return acc }, {})
      const remove: string[] = []
      for (const row of await Zotero.DB.queryAsync('SELECT itemID, itemKey, citekey FROM betterbibtexsearch.citekeys')) {
        const key = `${row.itemID}\t${row.itemKey}\t${row.citekey}`
        if (match[key]) {
          delete match[key]
        }
        else {
          remove.push(`'${row.itemKey}'`)
        }
      }
      const insert = Object.values(match)

      if (remove.length + insert.length) {
        await Zotero.DB.executeTransaction(async () => {
          if (remove.length) await Zotero.DB.queryAsync(`DELETE FROM betterbibtexsearch.citekeys WHERE itemKey in (${remove.join(',')})`)
          if (insert.length) {
            for (const row of insert) {
              await ZoteroDB.queryAsync('INSERT INTO betterbibtexsearch.citekeys (itemID, itemKey, citekey) VALUES (?, ?, ?)', [ row.itemID, row.itemKey, row.citekey ])
            }
          }
        })
      }

      const citekeySearchCondition = {
        name: 'citationKey',
        operators: {
          is: true,
          isNot: true,
          contains: true,
          doesNotContain: true,
        },
        table: 'betterbibtexsearch.citekeys',
        field: 'citekey',
        localized: 'Citation Key',
      }
      $patch$(Zotero.Search.prototype, 'addCondition', original => function addCondition(condition: string, operator: any, value: any, _required: any) {
        // detect a quick search being set up
        if (condition.match(/^quicksearch/)) this.__add_bbt_citekey = true
        // creator is always added in a quick search so use it as a trigger
        if (condition === 'creator' && this.__add_bbt_citekey) {
          original.call(this, citekeySearchCondition.name, operator, value, false)
          delete this.__add_bbt_citekey
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, prefer-rest-params
        return original.apply(this, arguments)
      })
      $patch$(Zotero.SearchConditions, 'hasOperator', original => function hasOperator(condition: string, operator: string | number) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        if (condition === citekeySearchCondition.name) return citekeySearchCondition.operators[operator]
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, prefer-rest-params
        return original.apply(this, arguments)
      })
      $patch$(Zotero.SearchConditions, 'get', original => function get(condition: string) {
        if (condition === citekeySearchCondition.name) return citekeySearchCondition
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, prefer-rest-params
        return original.apply(this, arguments)
      })
      $patch$(Zotero.SearchConditions, 'getStandardConditions', original => function getStandardConditions() {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, prefer-rest-params
        return original.apply(this, arguments).concat({
          name: citekeySearchCondition.name,
          localized: citekeySearchCondition.localized,
          operators: citekeySearchCondition.operators,
        }).sort((a: { localized: string }, b: { localized: any }) => a.localized.localeCompare(b.localized))
      })
      $patch$(Zotero.SearchConditions, 'getLocalizedName', original => function getLocalizedName(str: string) {
        if (str === citekeySearchCondition.name) return citekeySearchCondition.localized
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, prefer-rest-params
        return original.apply(this, arguments)
      })
    }

    Events.on('preference-changed', pref => {
      if (['autoAbbrevStyle', 'citekeyFormat', 'citekeyFold', 'skipWords'].includes(pref)) {
        Formatter.update('pref-change')
      }
    })

    this.keys.on(['insert', 'update'], async (citekey: { itemID: number, itemKey: any, citekey: any, pinned: any }) => {
      if (Preference.citekeySearch) {
        await ZoteroDB.queryAsync('INSERT OR REPLACE INTO betterbibtexsearch.citekeys (itemID, itemKey, citekey) VALUES (?, ?, ?)', [ citekey.itemID, citekey.itemKey, citekey.citekey ])
      }

      // async is just a heap of fun. Who doesn't enjoy a good race condition?
      // https://github.com/retorquere/zotero-better-bibtex/issues/774
      // https://groups.google.com/forum/#!topic/zotero-dev/yGP4uJQCrMc
      await sleep(Preference.itemObserverDelay)

      let item
      try {
        item = await Zotero.Items.getAsync(citekey.itemID)
      }
      catch (err) {
        // assume item has been deleted before we could get to it -- did I mention I hate async? I hate async
        log.error('could not load', citekey.itemID, err)
        return
      }

      // update display panes by issuing a fake item-update notification
      Zotero.Notifier.trigger('modify', 'item', [citekey.itemID], { [citekey.itemID]: { bbtCitekeyUpdate: true } })

      if (!citekey.pinned && this.autopin.enabled) {
        this.autopin.schedule(citekey.itemID, () => { this.pin([citekey.itemID]).catch(err => log.error('failed to pin', citekey.itemID, ':', err)) })
      }
      if (citekey.pinned && Preference.keyConflictPolicy === 'change') {
        const conflictQuery: Query = { $and: [
          { itemID: { $ne: item.id } },
          { pinned: { $eq: false } },
          { citekey: { $eq: citekey.citekey } },
        ]}
        if (Preference.keyScope !== 'global')  conflictQuery.$and.push( { libraryID: { $eq: item.libraryID } } )

        for (const conflict of this.keys.find(conflictQuery)) {
          item = await Zotero.Items.getAsync(conflict.itemID)
          this.update(item, conflict)
        }
      }
    })

    this.keys.on('delete', async (citekey: { itemID: any }) => {
      if (Preference.citekeySearch) {
        await ZoteroDB.queryAsync('DELETE FROM betterbibtexsearch.citekeys WHERE itemID = ?', [ citekey.itemID ])
      }
    })

    this.started = true
  }

  public async rescan(clean?: boolean): Promise<void> {
    if (Preference.scrubDatabase) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, no-prototype-builtins
      for (const item of this.keys.where(i => i.hasOwnProperty('extra'))) { // 799
        delete item.extra
        this.keys.update(item)
      }
    }

    if (Array.isArray(this.scanning)) {
      let left: string
      if (this.scanning.length) {
        left = `, ${this.scanning.length} items left`
      }
      else {
        left = ''
      }
      flash('Scanning still in progress', `Scan is still running${left}`)
      return
    }

    this.scanning = []

    if (clean) this.keys.removeDataOnly()

    const marker = '\uFFFD'

    const ids = []
    const items = await ZoteroDB.queryAsync(`
      SELECT item.itemID, item.libraryID, item.key, extra.value as extra, item.itemTypeID
      FROM items item
      LEFT JOIN itemData field ON field.itemID = item.itemID AND field.fieldID = ${this.query.field.extra}
      LEFT JOIN itemDataValues extra ON extra.valueID = field.valueID
      WHERE item.itemID NOT IN (select itemID from deletedItems)
      AND item.itemTypeID NOT IN (${this.query.type.attachment}, ${this.query.type.note}, ${this.query.type.annotation || this.query.type.note})
    `)
    for (const item of items) {
      ids.push(item.itemID)
      // if no citekey is found, it will be '', which will allow it to be found right after this loop
      const extra = Extra.get(item.extra, 'zotero', { citationKey: true })

      // don't fetch when clean is active because the removeDataOnly will have done it already
      const existing = clean ? null : this.keys.findOne($and({ itemID: item.itemID }))
      if (!existing) {
        // if the extra doesn't have a citekey, insert marker, next phase will find & fix it
        this.keys.insert({ citekey: extra.extraFields.citationKey || marker, pinned: !!extra.extraFields.citationKey, itemID: item.itemID, libraryID: item.libraryID, itemKey: item.key })

      }
      else if (extra.extraFields.citationKey && ((extra.extraFields.citationKey !== existing.citekey) || !existing.pinned)) {
        // we have an existing key in the DB, extra says it should be pinned to the extra value, but it's not.
        // update the DB to have the itemkey if necessaru
        this.keys.update({ ...existing, citekey: extra.extraFields.citationKey, pinned: true, itemKey: item.key })

      }
      else if (!existing.itemKey) {
        this.keys.update({ ...existing, itemKey: item.key })
      }
    }

    this.keys.findAndRemove({ itemID: { $nin: ids } })

    // find all references without citekey
    this.scanning = this.keys.find($and({ citekey: marker }))

    if (this.scanning.length !== 0) {
      const progressWin = new Zotero.ProgressWindow({ closeOnClick: false })
      progressWin.changeHeadline('Better BibTeX: Assigning citation keys')
      progressWin.addDescription(`Found ${this.scanning.length} references without a citation key`)
      const icon = `chrome://zotero/skin/treesource-unfiled${Zotero.hiDPI ? '@2x' : ''}.png`
      const progress = new progressWin.ItemProgress(icon, 'Assigning citation keys')
      progressWin.show()

      const eta = new ETA(this.scanning.length, { autoStart: true })
      for (let done = 0; done < this.scanning.length; done++) {
        let key = this.scanning[done]
        const item = await getItemsAsync(key.itemID)

        if (key.citekey === marker) {
          if (key.pinned) {
            const parsed = Extra.get(item.getField('extra'), 'zotero', { citationKey: true })
            item.setField('extra', parsed.extra)
            await item.saveTx({ [key.itemID]: { bbtCitekeyUpdate: true } })
          }
          key = null
        }

        try {
          this.update(item, key)
        }
        catch (err) {
          log.error('KeyManager.rescan: update', done, 'failed:', err)
        }

        eta.iterate()

        // eslint-disable-next-line no-magic-numbers
        if ((done % 10) === 1) {
          // eslint-disable-next-line no-magic-numbers
          progress.setProgress((eta.done * 100) / eta.count)
          progress.setText(eta.format(`${eta.done} / ${eta.count}, {{etah}} remaining`))
        }
      }

      // eslint-disable-next-line no-magic-numbers
      progress.setProgress(100)
      progress.setText('Ready')
      // eslint-disable-next-line no-magic-numbers
      progressWin.startCloseTimer(500)
    }

    this.scanning = null
  }

  public update(item: ZoteroItem, current?: { pinned: boolean, citekey: string }): string {
    if (item.isNote() || item.isAttachment() || item.isAnnotation?.()) return null

    current = current || this.keys.findOne($and({ itemID: item.id }))

    const proposed = this.propose(item)

    if (current && (current.pinned || !this.autopin.enabled) && (current.pinned === proposed.pinned) && (current.citekey === proposed.citekey)) return current.citekey

    if (current) {
      current.pinned = proposed.pinned
      current.citekey = proposed.citekey
      this.keys.update(current)
    }
    else {
      this.keys.insert({ itemID: item.id, libraryID: item.libraryID, itemKey: item.key, pinned: proposed.pinned, citekey: proposed.citekey })
    }

    return proposed.citekey
  }

  public remove(ids: any[]): void {
    if (!Array.isArray(ids)) ids = [ids]
    this.keys.findAndRemove({ itemID : { $in : ids } })
  }

  public get(itemID: number): { citekey: string, pinned: boolean, retry?: boolean } {
    // I cannot prevent being called before the init is done because Zotero unlocks the UI *way* before I'm getting the
    // go-ahead to *start* my init.
    if (!this.keys || !this.started) return { citekey: '', pinned: false, retry: true }

    const key = (this.keys.findOne($and({ itemID })) as { citekey: string, pinned: boolean })
    if (key) return key
    return { citekey: '', pinned: false, retry: true }
  }

  public propose(item: ZoteroItem): { citekey: string, pinned: boolean } {
    const citekey: string = Extra.get(item.getField('extra') as string, 'zotero', { citationKey: true }).extraFields.citationKey

    if (citekey) return { citekey, pinned: true }

    const proposed = Formatter.format(item)

    const conflictQuery: Query = { $and: [ { itemID: { $ne: item.id } } ] }
    if (Preference.keyScope !== 'global') conflictQuery.$and.push({ libraryID: { $eq: item.libraryID } })

    let postfix: string
    const seen = {}
    // eslint-disable-next-line no-constant-condition
    for (let n = proposed.postfix.start; true; n += 1) {
      if (n) {
        const alpha = intToExcelCol(n)
        postfix = sprintf(proposed.postfix.format, { a: alpha.toLowerCase(), A: alpha, n })
      }
      else {
        postfix = ''
      }

      // this should never happen, it'd mean the postfix pattern doesn't have placeholders, which should have been caught by parsePattern
      if (seen[postfix]) throw new Error(`${JSON.stringify(proposed.postfix)} does not generate unique postfixes`)
      seen[postfix] = true

      const postfixed = proposed.citekey + postfix
      const conflict = this.keys.findOne({ $and: [...conflictQuery.$and, { citekey: { $eq: postfixed } }] })
      if (conflict) continue

      return { citekey: postfixed, pinned: false }
    }
  }

  public async tagDuplicates(libraryID: number): Promise<void> {
    const tag = '#duplicate-citation-key'

    const tagged = (await ZoteroDB.queryAsync(`
      SELECT items.itemID
      FROM items
      JOIN itemTags ON itemTags.itemID = items.itemID
      JOIN tags ON tags.tagID = itemTags.tagID
      WHERE (items.libraryID = ? OR 'global' = ?) AND tags.name = ? AND items.itemID NOT IN (select itemID from deletedItems)
    `, [ libraryID, Preference.keyScope, tag ])).map((item: { itemID: number }) => item.itemID)

    const citekeys: {[key: string]: any[]} = {}
    for (const item of this.keys.find(Preference.keyScope === 'global' ? undefined : $and({ libraryID }))) {
      if (!citekeys[item.citekey]) citekeys[item.citekey] = []
      citekeys[item.citekey].push({ itemID: item.itemID, tagged: tagged.includes(item.itemID), duplicate: false })
      if (citekeys[item.citekey].length > 1) citekeys[item.citekey].forEach(i => i.duplicate = true)
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    const mistagged = Object.values(citekeys).reduce((acc, val) => acc.concat(val), []).filter(i => i.tagged !== i.duplicate).map(i => i.itemID)
    for (const item of await getItemsAsync(mistagged)) {
      if (tagged.includes(item.id)) {
        item.removeTag(tag)
      }
      else {
        item.addTag(tag)
      }

      await item.saveTx()
    }
  }

  private expandSelection(ids: 'selected' | number | number[]): number[] {
    if (Array.isArray(ids)) return ids

    if (ids === 'selected') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return Zotero.getActiveZoteroPane().getSelectedItems(true)
      }
      catch (err) { // zoteroPane.getSelectedItems() doesn't test whether there's a selection and errors out if not
        log.error('Could not get selected items:', err)
        return []
      }
    }

    return [ids]
  }
}
import React, { useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import namesData from './data/norwegian-names.json'
import './index.css'

const ACTIONS = {
  mark: 'mark',
  remove: 'remove',
  placeholder: 'placeholder',
  pseudonymize: 'pseudonymize'
}

const SENSITIVITY_LEVELS = [
  { label: 'Søk blant de 100 vanligste navnene', threshold: 700 },
  { label: 'Søk blant de 300 vanligste navnene', threshold: 500 },
  { label: 'Søk blant de 500 vanligste navnene', threshold: 300 },
  { label: 'Søk blant alle kjente navn', threshold: 100 }
]

const DEFAULT_SENSITIVITY = 500

const MONTHS = [
  'januar',
  'februar',
  'mars',
  'april',
  'mai',
  'juni',
  'juli',
  'august',
  'september',
  'oktober',
  'november',
  'desember'
]

const PLACEHOLDERS = {
  fnr: '[FØDSELSNUMMER]',
  dnr: '[D-NUMMER]',
  phone: '[TELEFON]',
  email: '[E-POST]',
  date: '[DATO]',
  name: '[NAVN]'
}

function getNameValue(entry) {
  if (typeof entry === 'string') return entry
  return entry?.name ?? ''
}

function getNameScore(entry) {
  if (typeof entry === 'object' && entry !== null) {
    return entry.score ?? Number.NEGATIVE_INFINITY
  }
  return Number.NEGATIVE_INFINITY
}

const AMBIGUOUS_NAMES = new Set(namesData.ambiguous.map((entry) => getNameValue(entry).toLowerCase()).filter(Boolean))
const LAST_NAMES = new Set(namesData.lastNames.map((entry) => getNameValue(entry).toLowerCase()).filter(Boolean))

const defaultAction = ACTIONS.placeholder

const LABELS = {
  fnr: 'Fødselsnummer',
  dnr: 'D-nummer',
  phone: 'Telefon',
  email: 'E-post',
  date: 'Dato',
  name: 'Navn'
}

function createMatch(start, end, value, piiType, confidence = 'high', meta = {}) {
  return { start, end, value, piiType, confidence, ...meta }
}

function hasValidDatePrefix(raw) {
  const digits = raw.replace(/\D/g, '')
  if (digits.length !== 11) return false

  const day = Number.parseInt(digits.slice(0, 2), 10)
  const month = Number.parseInt(digits.slice(2, 4), 10)

  const normalizedDay = day > 40 ? day - 40 : day
  return normalizedDay >= 1 && normalizedDay <= 31 && month >= 1 && month <= 12
}

function detectRegexPII(text) {
  const matches = []
  const addMatches = (regex, mapper) => {
    regex.lastIndex = 0
    let found
    while ((found = regex.exec(text)) !== null) {
      const mapped = mapper(found)
      if (mapped) matches.push(mapped)
    }
  }

  addMatches(/(?<!\d)(?:\d[\s-]?){10}\d(?!\d)/g, (found) => {
    const value = found[0]
    const digits = value.replace(/\D/g, '')
    if (digits.length !== 11 || !hasValidDatePrefix(value)) return null
    const firstDigit = Number.parseInt(digits[0], 10)
    const piiType = firstDigit >= 4 && firstDigit <= 7 ? 'dnr' : 'fnr'
    return createMatch(found.index, found.index + value.length, value, piiType)
  })

  addMatches(/\b(?:\+47[\s-]?)?(?:\d[\s-]?){7}\d\b/g, (found) => {
    const value = found[0]
    const normalized = value.replace(/\D/g, '')
    if (![8, 10].includes(normalized.length)) return null
    if (normalized.length === 10 && !normalized.startsWith('47')) return null
    return createMatch(found.index, found.index + value.length, value, 'phone')
  })

  addMatches(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (found) =>
    createMatch(found.index, found.index + found[0].length, found[0], 'email')
  )

  addMatches(/\b(?:0?[1-9]|[12]\d|3[01])[.\/-](?:0?[1-9]|1[0-2])[.\/-](?:19|20)\d{2}\b/g, (found) =>
    createMatch(found.index, found.index + found[0].length, found[0], 'date')
  )

  addMatches(
    new RegExp(`\\b(?:0?[1-9]|[12]\\d|3[01])\\.?\\s(?:${MONTHS.join('|')})\\s(?:19|20)\\d{2}\\b`, 'gi'),
    (found) => createMatch(found.index, found.index + found[0].length, found[0], 'date')
  )

  return matches
}

function detectNamePII(text, certainNames) {
  const wordRegex = /\b[\p{L}][\p{L}'-]*\b/gu
  const tokens = []
  let found

  while ((found = wordRegex.exec(text)) !== null) {
    tokens.push({ value: found[0], lower: found[0].toLowerCase(), start: found.index, end: found.index + found[0].length })
  }

  const matches = []
  const firstNameTokenIndexes = new Set()

  tokens.forEach((token, index) => {
    if (certainNames.has(token.lower)) {
      matches.push(createMatch(token.start, token.end, token.value, 'name', 'high', { nameRole: 'first' }))
      firstNameTokenIndexes.add(index)
    } else if (AMBIGUOUS_NAMES.has(token.lower)) {
      matches.push(createMatch(token.start, token.end, token.value, 'name', 'ambiguous', { nameRole: 'first' }))
      firstNameTokenIndexes.add(index)
    }
  })

  tokens.forEach((token, index) => {
    if (!LAST_NAMES.has(token.lower)) return
    const prevIsFirstName = firstNameTokenIndexes.has(index - 1)
    const nextIsFirstName = firstNameTokenIndexes.has(index + 1)
    if (prevIsFirstName || nextIsFirstName) {
      matches.push(createMatch(token.start, token.end, token.value, 'name', 'high', { nameRole: 'last' }))
    }
  })

  return matches
}

function dedupeMatches(matches) {
  const sorted = [...matches].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    const confidenceRank = { high: 0, ambiguous: 1 }
    return confidenceRank[a.confidence] - confidenceRank[b.confidence]
  })

  const accepted = []
  for (const candidate of sorted) {
    const overlap = accepted.find((item) => candidate.start < item.end && candidate.end > item.start)
    if (!overlap) {
      accepted.push(candidate)
    }
  }

  return accepted
}

function detectPII(text, certainNames) {
  return dedupeMatches([...detectRegexPII(text), ...detectNamePII(text, certainNames)])
}

function renderHighlightedText(text, matches) {
  if (!text) return null
  if (!matches.length) return <span>{text}</span>

  const chunks = []
  let cursor = 0

  matches.forEach((match, index) => {
    if (cursor < match.start) {
      chunks.push(<span key={`text-${index}`}>{text.slice(cursor, match.start)}</span>)
    }

    const className =
      match.confidence === 'high'
        ? 'bg-red-200 text-red-950 rounded px-1'
        : 'bg-yellow-200 text-yellow-950 rounded px-1'

    chunks.push(
      <mark key={`mark-${index}`} className={className}>
        {text.slice(match.start, match.end)}
      </mark>
    )

    cursor = match.end
  })

  if (cursor < text.length) {
    chunks.push(<span key="text-last">{text.slice(cursor)}</span>)
  }

  return chunks
}

function pseudonymizeText(text, matches) {
  const personMap = new Map()
  const legend = []

  const getPseudonym = (firstName) => {
    const key = firstName.toLowerCase()
    if (!personMap.has(key)) {
      const pseudonym = `Person ${personMap.size + 1}`
      personMap.set(key, { pseudonym, firstSeen: firstName })
      legend.push({ pseudonym, original: firstName })
    }

    return personMap.get(key).pseudonym
  }

  let output = ''
  let cursor = 0

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    output += text.slice(cursor, match.start)

    if (match.piiType !== 'name') {
      output += PLACEHOLDERS[match.piiType]
      cursor = match.end
      continue
    }

    if (match.nameRole !== 'first') {
      output += PLACEHOLDERS.name
      cursor = match.end
      continue
    }

    const pseudonym = getPseudonym(match.value)
    const nextMatch = matches[index + 1]
    const hasFollowingLastName =
      nextMatch &&
      nextMatch.piiType === 'name' &&
      nextMatch.nameRole === 'last' &&
      text.slice(match.end, nextMatch.start).trim() === ''

    output += pseudonym
    cursor = hasFollowingLastName ? nextMatch.end : match.end

    if (hasFollowingLastName) {
      index += 1
    }
  }

  output += text.slice(cursor)

  return { text: output, legend }
}

function transformText(text, matches, action) {
  if (!text) return { text: '', legend: [] }
  if (!matches.length) return { text, legend: [] }

  if (action === ACTIONS.pseudonymize) {
    return pseudonymizeText(text, matches)
  }

  let output = ''
  let cursor = 0

  matches.forEach((match) => {
    output += text.slice(cursor, match.start)
    if (action === ACTIONS.mark) {
      output += text.slice(match.start, match.end)
    } else if (action === ACTIONS.placeholder) {
      output += PLACEHOLDERS[match.piiType]
    }

    cursor = match.end
  })

  output += text.slice(cursor)
  return { text: output, legend: [] }
}

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function App() {
  const [inputText, setInputText] = useState('')
  const [loading, setLoading] = useState(false)
  const [globalAction, setGlobalAction] = useState(defaultAction)
  const [nameSensitivity, setNameSensitivity] = useState(DEFAULT_SENSITIVITY)
  const [ignoredYellow, setIgnoredYellow] = useState(new Set())

  const certainNames = useMemo(
    () =>
      new Set(
        namesData.certain
          .filter((entry) => getNameScore(entry) >= nameSensitivity)
          .map((entry) => getNameValue(entry).toLowerCase())
          .filter(Boolean)
      ),
    [nameSensitivity]
  )

  const allMatches = useMemo(() => detectPII(inputText, certainNames), [inputText, certainNames])

  const filteredMatches = useMemo(
    () => allMatches.filter((match) => !(match.confidence === 'ambiguous' && ignoredYellow.has(match.value.toLowerCase()))),
    [allMatches, ignoredYellow]
  )

  const reviewItems = useMemo(() => {
    const bucket = new Map()
    allMatches
      .filter((match) => match.confidence === 'ambiguous')
      .forEach((match) => {
        const key = match.value.toLowerCase()
        bucket.set(key, {
          value: match.value,
          count: (bucket.get(key)?.count ?? 0) + 1,
          ignored: ignoredYellow.has(key)
        })
      })

    return [...bucket.values()]
  }, [allMatches, ignoredYellow])

  const transformedResult = useMemo(
    () => transformText(inputText, filteredMatches, globalAction),
    [inputText, filteredMatches, globalAction]
  )

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    setLoading(true)
    try {
      const extension = file.name.split('.').pop()?.toLowerCase()

      if (extension === 'txt') {
        setInputText(await file.text())
      } else if (extension === 'csv') {
        const parsed = await new Promise((resolve, reject) => {
          Papa.parse(file, {
            complete: resolve,
            error: reject
          })
        })
        const lines = parsed.data.map((row) => (Array.isArray(row) ? row.join('; ') : String(row)))
        setInputText(lines.join('\n'))
      } else if (extension === 'xlsx') {
        const buffer = await file.arrayBuffer()
        const workbook = XLSX.read(buffer, { type: 'array' })
        const sheetsText = workbook.SheetNames.map((sheetName) => XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]))
        setInputText(sheetsText.join('\n'))
      }
    } finally {
      setLoading(false)
      event.target.value = ''
    }
  }

  const noMatches = inputText && filteredMatches.length === 0

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
        <header>
          <h1 className="text-3xl font-bold">PersonWerner</h1>
          <p className="mt-2 text-slate-700">PII-deteksjon for kommunehelter. Alt skjer i nettleseren din.</p>
        </header>

        <section className="rounded-xl bg-white p-4 shadow">
          <p className="mb-3 text-sm text-slate-600">Last opp CSV, XLSX eller TXT</p>
          <input type="file" accept=".csv,.xlsx,.txt" onChange={handleFileUpload} className="mb-4 block w-full" />
          <p className="mb-2 text-sm text-slate-600">...eller lim inn tekst</p>
          <textarea
            value={inputText}
            onChange={(event) => setInputText(event.target.value)}
            placeholder="PersonWerner er klar til jobb. Last opp en fil eller lim inn tekst."
            className="h-40 w-full rounded-lg border border-slate-300 p-3 font-mono text-sm"
          />
          {loading && <p className="mt-2 text-sm font-medium text-blue-700">Werner jobber...</p>}

          <label className="mt-4 flex flex-col gap-1 text-sm">
            <span className="font-medium text-slate-700">Sensitivitet – hvor mange navn skal Werner lete etter?</span>
            <select
              value={nameSensitivity}
              onChange={(event) => setNameSensitivity(Number.parseInt(event.target.value, 10))}
              className="rounded border border-slate-300 p-2"
            >
              {SENSITIVITY_LEVELS.map((level) => (
                <option key={level.threshold} value={level.threshold}>
                  {level.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="grid gap-6 lg:grid-cols-3">
          <article className="rounded-xl bg-white p-4 shadow lg:col-span-2">
            <h2 className="mb-3 text-xl font-semibold">Funn og markering</h2>
            {inputText && (
              <p className="mb-3 inline-flex rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700">
                Werner fant {filteredMatches.length} treff
              </p>
            )}
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 whitespace-pre-wrap break-words leading-relaxed">
              {inputText ? (
                renderHighlightedText(inputText, filteredMatches)
              ) : (
                <p className="text-slate-500">PersonWerner er klar til jobb. Last opp en fil eller lim inn tekst.</p>
              )}
            </div>
            {noMatches && (
              <p className="mt-3 rounded bg-emerald-50 p-3 text-emerald-800">
                Ingen tvetydige treff foreløpig.
              </p>
            )}
          </article>

          <aside className="rounded-xl bg-white p-4 shadow">
            <h2 className="text-xl font-semibold">Gul-liste (trenger review)</h2>
            <div className="mt-3 space-y-2">
              {reviewItems.length === 0 ? (
                <p className="text-sm text-slate-500">Ingen tvetydige treff foreløpig.</p>
              ) : (
                reviewItems.map((item) => (
                  <label key={item.value.toLowerCase()} className="flex items-center justify-between gap-2 rounded border p-2">
                    <span>
                      {item.value} <span className="text-xs text-slate-500">({item.count})</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={!item.ignored}
                      onChange={() => {
                        setIgnoredYellow((prev) => {
                          const next = new Set(prev)
                          const key = item.value.toLowerCase()
                          if (next.has(key)) {
                            next.delete(key)
                          } else {
                            next.add(key)
                          }
                          return next
                        })
                      }}
                    />
                  </label>
                ))
              )}
            </div>
          </aside>
        </section>

        <section className="rounded-xl bg-white p-4 shadow">
          <h2 className="text-xl font-semibold">Tiltak for bekreftet PII</h2>
          <div className="mt-3 max-w-xl">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">Hva vil du gjøre med all bekreftet PII?</span>
              <select
                value={globalAction}
                onChange={(event) => setGlobalAction(event.target.value)}
                className="rounded border border-slate-300 p-2"
              >
                <option value={ACTIONS.mark}>Marker</option>
                <option value={ACTIONS.remove}>Fjern</option>
                <option value={ACTIONS.placeholder}>Erstatt med plassholder</option>
                <option value={ACTIONS.pseudonymize}>Pseudonymiser</option>
              </select>
            </label>
          </div>

          <p className="mt-3 text-xs text-slate-500">
            Gjelder: {Object.values(LABELS).join(', ')}.
          </p>

          <div className="mt-4">
            <h3 className="font-semibold">Resultat</h3>
            <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 whitespace-pre-wrap break-words text-sm">
              {transformedResult.text || 'Ingen tekst å vise enda.'}
            </pre>

            {globalAction === ACTIONS.pseudonymize && transformedResult.legend.length > 0 && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                <p className="font-medium">Forklaring</p>
                <p className="mt-1 text-slate-700">
                  {transformedResult.legend.map((item) => `${item.pseudonym} = ${item.original}`).join(', ')}
                </p>
              </div>
            )}
          </div>

          <div className="mt-4 grid gap-2 sm:flex sm:flex-wrap">
            <button
              type="button"
              onClick={() => downloadBlob(transformedResult.text, 'personwerner-resultat.txt', 'text/plain;charset=utf-8')}
              className="w-full rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white sm:w-auto"
            >
              Last ned TXT
            </button>
            <button
              type="button"
              onClick={() => {
                const csv = Papa.unparse([{ resultat: transformedResult.text }])
                downloadBlob(csv, 'personwerner-resultat.csv', 'text/csv;charset=utf-8')
              }}
              className="w-full rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white sm:w-auto"
            >
              Last ned CSV
            </button>
          </div>
        </section>
      </div>
    </main>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

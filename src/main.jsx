import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import namesData from './data/norwegian-names.json'
import './index.css'
import { detectPII, getNameScore } from './pii-detector'

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

function getNameValue(entry) {
  if (typeof entry === 'string') return entry
  return entry?.name ?? ''
}

const defaultAction = ACTIONS.placeholder

const LABELS = {
  fnr: 'Fødselsnummer',
  dnr: 'D-nummer',
  phone: 'Telefon',
  email: 'E-post',
  date: 'Dato',
  name: 'Navn'
}


const PLACEHOLDERS = {
  fnr: '[FØDSELSNUMMER]',
  dnr: '[D-NUMMER]',
  phone: '[TELEFON]',
  email: '[E-POST]',
  date: '[DATO]',
  name: '[NAVN]',
  manual: '[PII]'
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
        {match.manual && (
          <span className="ml-1 inline-flex rounded bg-red-700 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
            Lagt til manuelt
          </span>
        )}
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

function formatLegend(legend) {
  if (!legend.length) return ''
  return `🔑 Nøkkel: ${legend.map((item) => `${item.pseudonym} = ${item.original}`).join(', ')}`
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
  const [manualMatches, setManualMatches] = useState([])
  const [selectionCandidate, setSelectionCandidate] = useState(null)
  const resultsRef = useRef(null)

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

  const confirmedMatches = useMemo(
    () => [...filteredMatches, ...manualMatches].sort((a, b) => a.start - b.start || a.end - b.end),
    [filteredMatches, manualMatches]
  )

  const reviewItems = useMemo(() => {
    const bucket = new Map()
    allMatches
      .filter((match) => match.confidence === 'ambiguous')
      .forEach((match) => {
        const key = match.value.toLowerCase()
        bucket.set(key, {
          value: match.value,
          label: match.reviewLabel,
          count: (bucket.get(key)?.count ?? 0) + 1,
          ignored: ignoredYellow.has(key)
        })
      })

    return [...bucket.values()]
  }, [allMatches, ignoredYellow])

  const transformedResult = useMemo(() => transformText(inputText, confirmedMatches, globalAction), [inputText, confirmedMatches, globalAction])

  const formattedLegend = useMemo(() => formatLegend(transformedResult.legend), [transformedResult.legend])

  const resetInputText = (nextValue) => {
    setInputText(nextValue)
    setManualMatches([])
    setSelectionCandidate(null)
  }

  useEffect(() => {
    const handleSelectionChange = () => {
      const container = resultsRef.current
      const selection = window.getSelection()

      if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
        setSelectionCandidate(null)
        return
      }

      const range = selection.getRangeAt(0)
      if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
        setSelectionCandidate(null)
        return
      }

      const selectedText = selection.toString()
      if (!selectedText.trim()) {
        setSelectionCandidate(null)
        return
      }

      const prefixRange = range.cloneRange()
      prefixRange.selectNodeContents(container)
      prefixRange.setEnd(range.startContainer, range.startOffset)
      const start = prefixRange.toString().length
      const end = start + selectedText.length

      const overlapsExisting = confirmedMatches.some((match) => start < match.end && end > match.start)
      if (overlapsExisting) {
        setSelectionCandidate(null)
        return
      }

      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        setSelectionCandidate(null)
        return
      }

      setSelectionCandidate({
        start,
        end,
        text: selectedText,
        top: Math.max(rect.top - 40, 8),
        left: Math.min(Math.max(rect.left + rect.width / 2, 60), window.innerWidth - 60)
      })
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [confirmedMatches])

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    setLoading(true)
    try {
      const extension = file.name.split('.').pop()?.toLowerCase()

      if (extension === 'txt') {
        resetInputText(await file.text())
      } else if (extension === 'csv') {
        const parsed = await new Promise((resolve, reject) => {
          Papa.parse(file, {
            complete: resolve,
            error: reject
          })
        })
        const lines = parsed.data.map((row) => (Array.isArray(row) ? row.join('; ') : String(row)))
        resetInputText(lines.join('\n'))
      } else if (extension === 'xlsx') {
        const buffer = await file.arrayBuffer()
        const workbook = XLSX.read(buffer, { type: 'array' })
        const sheetsText = workbook.SheetNames.map((sheetName) => XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]))
        resetInputText(sheetsText.join('\n'))
      }
    } finally {
      setLoading(false)
      event.target.value = ''
    }
  }

  const noMatches = inputText && confirmedMatches.length === 0

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
            onChange={(event) => resetInputText(event.target.value)}
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
                Werner fant {confirmedMatches.length} treff
              </p>
            )}
            <div
              ref={resultsRef}
              className="rounded-lg border border-slate-200 bg-slate-50 p-3 whitespace-pre-wrap break-words leading-relaxed"
            >
              {inputText ? (
                renderHighlightedText(inputText, confirmedMatches)
              ) : (
                <p className="text-slate-500">PersonWerner er klar til jobb. Last opp en fil eller lim inn tekst.</p>
              )}
            </div>
            {selectionCandidate && (
              <button
                type="button"
                style={{ top: selectionCandidate.top, left: selectionCandidate.left, transform: 'translateX(-50%)' }}
                className="fixed z-20 rounded-full bg-red-700 px-3 py-1 text-xs font-semibold text-white shadow-lg"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setManualMatches((prev) => [
                    ...prev,
                    {
                      value: selectionCandidate.text,
                      start: selectionCandidate.start,
                      end: selectionCandidate.end,
                      confidence: 'high',
                      piiType: 'manual',
                      manual: true
                    }
                  ])
                  setSelectionCandidate(null)
                  window.getSelection()?.removeAllRanges()
                }}
              >
                + Merk som PII
              </button>
            )}
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
                      {item.label && <span className="ml-2 text-xs text-slate-500">{item.label}</span>}
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
                <p className="text-slate-700">{formattedLegend}</p>
              </div>
            )}
          </div>

          <div className="mt-4 grid gap-2 sm:flex sm:flex-wrap">
            <button
              type="button"
              onClick={() => {
                const txtContent =
                  globalAction === ACTIONS.pseudonymize && formattedLegend
                    ? `${transformedResult.text}\n\n${formattedLegend}`
                    : transformedResult.text

                downloadBlob(txtContent, 'personwerner-resultat.txt', 'text/plain;charset=utf-8')
              }}
              className="w-full rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white sm:w-auto"
            >
              Last ned TXT
            </button>
            <button
              type="button"
              onClick={() => {
                const rows = [{ resultat: transformedResult.text }]

                if (globalAction === ACTIONS.pseudonymize && formattedLegend) {
                  rows.push({ resultat: formattedLegend })
                }

                const csv = Papa.unparse(rows)
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

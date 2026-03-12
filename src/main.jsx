import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import namesData from './data/norwegian-names.json'
import './index.css'
import { detectPII, getNameScore } from './pii-detector'

const ACTIONS = {
  remove: 'remove',
  pseudonymize: 'pseudonymize'
}

const SENSITIVITY_LEVELS = [
  { label: 'Rask', threshold: 700 },
  { label: 'Standard', threshold: 500 },
  { label: 'Grundig', threshold: 300 }
]

const DEFAULT_SENSITIVITY = 500

function getNameValue(entry) {
  if (typeof entry === 'string') return entry
  return entry?.name ?? ''
}

const defaultAction = ''

const PLACEHOLDERS = {
  fnr: '[FØDSELSNUMMER]',
  dnr: '[D-NUMMER]',
  phone: '[TELEFON]',
  email: '[E-POST]',
  date: '[DATO]',
  name: '[NAVN]',
  manual: '[PERSONDATA]'
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
  if (!matches.length || !action) return { text, legend: [] }

  if (action === ACTIONS.pseudonymize) {
    return pseudonymizeText(text, matches)
  }

  let output = ''
  let cursor = 0

  matches.forEach((match) => {
    output += text.slice(cursor, match.start)
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
  const [showDisclaimer, setShowDisclaimer] = useState(false)
  const [inputText, setInputText] = useState('')
  const [loading, setLoading] = useState(false)
  const [fileError, setFileError] = useState('')
  const [globalAction, setGlobalAction] = useState(defaultAction)
  const [nameSensitivity, setNameSensitivity] = useState(DEFAULT_SENSITIVITY)
  const [currentStep, setCurrentStep] = useState(1)
  const [analysisRan, setAnalysisRan] = useState(false)
  const [hasReviewed, setHasReviewed] = useState(false)
  const [analyzedText, setAnalyzedText] = useState('')
  const [analyzedSensitivity, setAnalyzedSensitivity] = useState(DEFAULT_SENSITIVITY)
  const [ignoredYellow, setIgnoredYellow] = useState(new Set())
  const [manualMatches, setManualMatches] = useState([])
  const [selectionCandidate, setSelectionCandidate] = useState(null)
  const resultsRef = useRef(null)

  const certainNames = useMemo(
    () =>
      new Set(
        namesData.certain
          .filter((entry) => getNameScore(entry) >= analyzedSensitivity)
          .map((entry) => getNameValue(entry).toLowerCase())
          .filter(Boolean)
      ),
    [analyzedSensitivity]
  )

  const allMatches = useMemo(() => detectPII(analyzedText, certainNames), [analyzedText, certainNames])

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
          count: (bucket.get(key)?.count ?? 0) + 1,
          ignored: ignoredYellow.has(key)
        })
      })

    return [...bucket.values()]
  }, [allMatches, ignoredYellow])

  const transformedResult = useMemo(
    () => transformText(analyzedText, confirmedMatches, globalAction),
    [analyzedText, confirmedMatches, globalAction]
  )

  const formattedLegend = useMemo(() => formatLegend(transformedResult.legend), [transformedResult.legend])

  useEffect(() => {
    const disclaimerSeen = window.localStorage.getItem('personwerner-disclaimer-seen')
    if (!disclaimerSeen) {
      setShowDisclaimer(true)
    }
  }, [])

  const resetInputText = (nextValue) => {
    setInputText(nextValue)
    setAnalysisRan(false)
    setHasReviewed(false)
    setGlobalAction(defaultAction)
    setManualMatches([])
    setSelectionCandidate(null)
    setFileError('')
    setIgnoredYellow(new Set())
    setCurrentStep(1)
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
    setFileError('')
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
      } else {
        setFileError('Werner klarte ikke å lese filen. Prøv et annet format, eller lim inn teksten direkte.')
      }
    } catch {
      setFileError('Werner klarte ikke å lese filen. Prøv et annet format, eller lim inn teksten direkte.')
    } finally {
      setLoading(false)
      event.target.value = ''
    }
  }

  const highConfidenceCount = confirmedMatches.filter((match) => match.confidence === 'high').length
  const uncertainCount = filteredMatches.filter((match) => match.confidence === 'ambiguous').length
  const noMatches = analysisRan && analyzedText && confirmedMatches.length === 0

  const runAnalysis = () => {
    if (!inputText.trim()) return
    setAnalyzedText(inputText)
    setAnalyzedSensitivity(nameSensitivity)
    setIgnoredYellow(new Set())
    setManualMatches([])
    setSelectionCandidate(null)
    setGlobalAction(defaultAction)
    setAnalysisRan(true)
    setHasReviewed(false)
    setCurrentStep(2)
  }

  const startOver = () => {
    resetInputText('')
    setAnalyzedText('')
    setAnalyzedSensitivity(DEFAULT_SENSITIVITY)
    setNameSensitivity(DEFAULT_SENSITIVITY)
    setCurrentStep(1)
  }

  const steps = [
    { id: 1, label: 'Last opp' },
    { id: 2, label: 'Gå gjennom' },
    { id: 3, label: 'Eksporter' }
  ]

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      {showDisclaimer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <section className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-2xl font-bold">Før du bruker PersonWerner</h2>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-slate-700">
              <li>Dataen din sendes ikke til oss eller andre tjenester.</li>
              <li>Alt behandles lokalt i nettleseren din, på din egen enhet.</li>
              <li>Du har ansvar for å kvalitetssikre resultatet før du deler noe videre.</li>
              <li>Unngå ekstra sensitive dokumenter hvis du er usikker på innholdet.</li>
              <li>Store filer kan gjøre nettleseren treg eller ustabil.</li>
            </ul>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700"
                onClick={() => setShowDisclaimer(false)}
              >
                Avbryt
              </button>
              <button
                type="button"
                className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white"
                onClick={() => {
                  window.localStorage.setItem('personwerner-disclaimer-seen', '1')
                  setShowDisclaimer(false)
                }}
              >
                Jeg forstår – fortsett
              </button>
            </div>
          </section>
        </div>
      )}

      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
        <header className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-lg font-bold text-white">W</div>
          <div>
            <h1 className="text-3xl font-bold">PersonWerner</h1>
            <p className="text-base text-slate-700">Werner verner – og fjerner. Men du er sjefen.</p>
          </div>
        </header>

        <section className="sticky top-0 z-20 rounded-xl border border-slate-200 bg-white/95 p-4 shadow backdrop-blur">
          <nav className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {steps.map((step, index) => {
              const isCurrent = currentStep === step.id
              const isCompleted = currentStep > step.id

              return (
                <React.Fragment key={step.id}>
                  <button
                    type="button"
                    disabled={!isCompleted && !isCurrent}
                    onClick={() => setCurrentStep(step.id)}
                    className={`rounded-full px-4 py-2 transition ${
                      isCurrent
                        ? 'bg-blue-600 text-white'
                        : isCompleted
                          ? 'bg-blue-100 text-blue-800 hover:bg-blue-200'
                          : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {step.id}. {step.label}
                  </button>
                  {index < steps.length - 1 && <span className="text-slate-400">→</span>}
                </React.Fragment>
              )
            })}
          </nav>
        </section>

        {currentStep === 1 && (
          <section className="rounded-xl bg-white p-5 shadow">
            <h2 className="text-2xl font-semibold">Last opp</h2>
            <p className="helper-text mb-3 mt-1">Last opp CSV, XLSX eller TXT</p>
            <input type="file" accept=".csv,.xlsx,.txt" onChange={handleFileUpload} className="mb-4 block w-full" />
            <p className="helper-text mb-2">...eller lim inn tekst</p>
            <textarea
              value={inputText}
              onChange={(event) => resetInputText(event.target.value)}
              placeholder="PersonWerner er klar til jobb. Last opp en fil eller lim inn tekst."
              className="h-56 w-full rounded-lg border border-slate-300 p-3 font-mono text-sm"
            />
            <p className="helper-text mt-3">
              Werner leser teksten din lokalt i nettleseren. Ingen data sendes til servere, skyer eller Werner selv. Han er
              litt gammeldags sånn. 🖥️
            </p>
            {loading && <p className="mt-2 text-sm font-medium text-blue-700">Werner er på saken...</p>}
            {fileError && <p className="mt-2 text-sm font-medium text-red-700">{fileError}</p>}

            <label className="mt-4 flex flex-col gap-1 text-sm">
              <span className="font-medium text-slate-700">Grundighet</span>
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

            <button
              type="button"
              disabled={loading || !inputText.trim()}
              className="mt-6 w-full rounded-lg bg-blue-600 px-5 py-4 text-lg font-semibold text-white disabled:opacity-60"
              onClick={runAnalysis}
            >
              Analyser →
            </button>
          </section>
        )}

        {currentStep === 2 && analysisRan && (
          <section className="rounded-xl bg-white p-5 shadow">
            <h2 className="text-2xl font-semibold">Gå gjennom</h2>
            <p className="helper-text mt-2">
              Werner fant <strong>{highConfidenceCount}</strong> sannsynlige og <strong>{uncertainCount}</strong> usikre treff
            </p>
            <p className="helper-text mt-2">
              Rødt = Werner er ganske sikker. Gult = Werner er usikker – du bestemmer. Ser du noe som mangler? Marker
              teksten selv og klikk '+ Legg til'.
            </p>

            <div
              ref={resultsRef}
              className="relative mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words"
            >
              {renderHighlightedText(analyzedText, confirmedMatches)}
            </div>

            {selectionCandidate && (
              <button
                type="button"
                className="fixed z-40 -translate-x-1/2 rounded-full bg-red-700 px-3 py-1 text-xs font-semibold text-white shadow-lg"
                style={{ top: `${selectionCandidate.top}px`, left: `${selectionCandidate.left}px` }}
                onClick={() => {
                  setManualMatches((prev) => [
                    ...prev,
                    {
                      start: selectionCandidate.start,
                      end: selectionCandidate.end,
                      value: selectionCandidate.text,
                      piiType: 'manual',
                      confidence: 'high',
                      manual: true
                    }
                  ])
                  setSelectionCandidate(null)
                  window.getSelection()?.removeAllRanges()
                  setHasReviewed(true)
                }}
              >
                + Merk som persondata
              </button>
            )}

            {noMatches && (
              <p className="mt-3 rounded bg-emerald-50 p-3 text-emerald-800">
                Ingen persondata funnet. Enten er dokumentet rent, eller så er Werner litt for optimistisk i dag. Sjekk gjerne
                manuelt også. 🎉
              </p>
            )}

            <h3 className="mt-5 text-base font-semibold">Bør sjekkes</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {reviewItems.length === 0 ? (
                <p className="text-xs text-slate-500">Ingen usikre treff.</p>
              ) : (
                reviewItems.map((item) => (
                  <label
                    key={item.value.toLowerCase()}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-sm"
                  >
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
                        setHasReviewed(true)
                      }}
                    />
                    <span>
                      {item.value} ({item.count})
                    </span>
                  </label>
                ))
              )}
            </div>

            <button type="button" onClick={() => setHasReviewed(true)} className="mt-4 text-sm text-blue-700 underline">
              + Legg til navn Werner gikk glipp av
            </button>

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={startOver}
                className="rounded-lg border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700"
              >
                ← Start på nytt
              </button>
              <button
                type="button"
                onClick={() => {
                  setHasReviewed(true)
                  setCurrentStep(3)
                }}
                className="rounded-lg bg-blue-600 px-5 py-3 text-base font-semibold text-white"
              >
                Jeg er ferdig →
              </button>
            </div>
          </section>
        )}

        {currentStep === 3 && analysisRan && (
          <section className="rounded-xl bg-white p-5 shadow">
            <h2 className="text-2xl font-semibold">Eksporter</h2>
            <p className="helper-text mt-2">
              Velg hva som skal skje med all bekreftet persondata, last ned og du er i mål. Husk å lese gjennom én gang til
              – Werner er flink, men ikke ufeilbarlig. 🤓
            </p>
            <p className="mt-2 text-lg font-medium">Hva vil du gjøre med persondata?</p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setGlobalAction(ACTIONS.remove)}
                className="rounded-lg border border-slate-300 px-4 py-4 text-base font-semibold hover:bg-slate-50"
              >
                Fjern
              </button>
              <button
                type="button"
                onClick={() => setGlobalAction(ACTIONS.pseudonymize)}
                className="rounded-lg border border-slate-300 px-4 py-4 text-base font-semibold hover:bg-slate-50"
              >
                Pseudonymiser
              </button>
            </div>

            <div className="mt-4">
              <h3 className="font-semibold">Resultat</h3>
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 whitespace-pre-wrap break-words text-sm">
                {globalAction ? transformedResult.text : 'Velg et tiltak for å se resultatet.'}
              </pre>
            </div>

            {globalAction === ACTIONS.pseudonymize && transformedResult.legend.length > 0 && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                <p className="text-slate-700">{formattedLegend}</p>
              </div>
            )}

            {globalAction && (
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
            )}

            <button
              type="button"
              onClick={() => setCurrentStep(2)}
              className="mt-5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
            >
              ← Tilbake til gjennomgang
            </button>

            <footer className="mt-8 border-t border-slate-200 pt-4 text-center text-sm text-slate-600">
              PersonWerner behandler ingen data. Alt skjer i nettleseren din. 🔒
            </footer>
          </section>
        )}
      </div>
    </main>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

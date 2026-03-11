import namesData from './data/norwegian-names.json'

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

const NON_NAME_CAPITALIZED_WORDS = new Set([
  'norge',
  'norsk',
  'oslo',
  'bergen',
  'trondheim',
  'stavanger',
  'tønsberg',
  'kristiansand',
  'tromsø',
  'drammen',
  'fredrikstad',
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
  'desember',
  'mandag',
  'tirsdag',
  'onsdag',
  'torsdag',
  'fredag',
  'lørdag',
  'søndag',
  'kommune',
  'fylke',
  'stat',
  'regjeringen',
  'stortinget',
  'moderator',
  'intervjuer',
  'arkivet',
  'nguyen',
  'abdulrahman'
])

function getNameValue(entry) {
  if (typeof entry === 'string') return entry
  return entry?.name ?? ''
}

export function getNameScore(entry) {
  if (typeof entry === 'object' && entry !== null) {
    return entry.score ?? Number.NEGATIVE_INFINITY
  }
  return Number.NEGATIVE_INFINITY
}

const AMBIGUOUS_NAMES = new Set(namesData.ambiguous.map((entry) => getNameValue(entry).toLowerCase()).filter(Boolean))
const LAST_NAMES = new Set(namesData.lastNames.map((entry) => getNameValue(entry).toLowerCase()).filter(Boolean))

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

function isCapitalizedNameToken(token) {
  if (!token?.value) return false

  const parts = token.value.split('-')
  return parts.every((part) => /^[\p{Lu}][\p{L}']*$/u.test(part))
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
    if (!isCapitalizedNameToken(token)) return

    if (certainNames.has(token.lower)) {
      matches.push(createMatch(token.start, token.end, token.value, 'name', 'high', { nameRole: 'first' }))
      firstNameTokenIndexes.add(index)
    } else if (AMBIGUOUS_NAMES.has(token.lower)) {
      matches.push(createMatch(token.start, token.end, token.value, 'name', 'ambiguous', { nameRole: 'first' }))
      firstNameTokenIndexes.add(index)
    }
  })

  tokens.forEach((token, index) => {
    if (!isCapitalizedNameToken(token)) return
    if (!LAST_NAMES.has(token.lower)) return
    const prevIsFirstName = firstNameTokenIndexes.has(index - 1)
    const nextIsFirstName = firstNameTokenIndexes.has(index + 1)
    if (prevIsFirstName || nextIsFirstName) {
      matches.push(createMatch(token.start, token.end, token.value, 'name', 'high', { nameRole: 'last' }))
    }
  })

  return matches
}

function detectCapitalizedPairPII(text, certainNames) {
  const nameRegex = /\b([A-ZÆØÅ][a-zæøå'-]+(?:\s+[A-ZÆØÅ]\.)?(?:\s+[A-ZÆØÅ][a-zæøå'-]+){1,2})\b/gu
  let found
  const matches = []

  while ((found = nameRegex.exec(text)) !== null) {
    const fullMatch = found[1]
    const words = fullMatch
      .split(/\s+/u)
      .map((word) => word.replace(/\.$/u, ''))
      .filter(Boolean)
    const normalizedWords = words.map((word) => word.toLowerCase())

    if (normalizedWords.length === 0 || NON_NAME_CAPITALIZED_WORDS.has(normalizedWords[0])) {
      continue
    }

    const containsCertain = normalizedWords.some((word) => certainNames.has(word))
    const containsAmbiguous = normalizedWords.some((word) => AMBIGUOUS_NAMES.has(word))

    const confidence = containsCertain ? 'high' : 'ambiguous'
    const reviewLabel = !containsCertain && !containsAmbiguous ? 'Mulig navn (ukjent)' : undefined

    matches.push(
      createMatch(found.index, found.index + fullMatch.length, fullMatch, 'name', confidence, {
        nameRole: 'first',
        reviewLabel
      })
    )
  }

  return matches
}

function detectContextualNamePII(text, certainNames) {
  const contextRegex =
    /\b(?:[Hh]eter|[Mm]øtte|[Ss]a|[Ii]følge|[Kk]ontaktet|[Rr]ådgiver|[Ss]aksbehandler|[Kk]ontaktperson|[Ss]nakket\s+[Mm]ed)\s+([\p{Lu}][\p{L}'-]*(?:\s+[\p{Lu}][\p{L}'-]*)?)\b/gu

  const matches = []
  let found

  while ((found = contextRegex.exec(text)) !== null) {
    const fullName = found[1]
    const words = fullName.split(/\s+/u).map((word) => word.toLowerCase())
    const isCertain = certainNames.has(fullName.toLowerCase()) || words.some((word) => certainNames.has(word))

    matches.push(
      createMatch(found.index + found[0].length - fullName.length, found.index + found[0].length, fullName, 'name', isCertain ? 'high' : 'ambiguous', {
        nameRole: 'first',
        reviewLabel: isCertain ? undefined : 'Mulig navn (kontekst)'
      })
    )
  }

  return matches
}

function dedupeMatches(matches) {
  const sorted = [...matches].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start

    const confidenceRank = { high: 0, ambiguous: 1 }
    if (confidenceRank[a.confidence] !== confidenceRank[b.confidence]) {
      return confidenceRank[a.confidence] - confidenceRank[b.confidence]
    }

    return b.end - a.end
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

export function detectPII(text, certainNames) {
  const regexMatches = detectRegexPII(text)
  const nameMatches = detectNamePII(text, certainNames)
  const capitalizedPairMatches = detectCapitalizedPairPII(text, certainNames)
  const contextualNameMatches = detectContextualNamePII(text, certainNames)
  return dedupeMatches([...regexMatches, ...nameMatches, ...capitalizedPairMatches, ...contextualNameMatches])
}

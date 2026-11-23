const extensions = new Map(Object.entries({
  bash: 'sh', c: 'c', cpp: 'cpp', csharp: 'cs', dart: 'dart', elixir: 'ex',
  erlang: 'erl', golang: 'go', java: 'java', javascript: 'js', kotlin: 'kt',
  mssql: 'sql', mysql: 'sql', oraclesql: 'sql', pandas: 'py', php: 'php',
  postgresql: 'sql', python: 'py', python3: 'py', racket: 'rkt', ruby: 'rb',
  rust: 'rs', scala: 'scala', swift: 'swift', typescript: 'ts',
}));

export const MAX_CODE_BYTES = 256 * 1024;
export const MAX_PROBLEM_BYTES = 104 * 1024;
const maxDescriptionBytes = 96 * 1024;
const encoder = new TextEncoder();

const languageNames = new Map(Object.entries({
  cpp: 'C++', csharp: 'C#', golang: 'Go', javascript: 'JavaScript', mssql: 'SQL Server',
  mysql: 'MySQL', oraclesql: 'Oracle SQL', php: 'PHP', postgresql: 'PostgreSQL',
  python3: 'Python 3', typescript: 'TypeScript',
}));

const difficultyColors = { Easy: '137B59', Medium: 'A65E00', Hard: 'BC303C' };

function asText(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';
}

export function submissionTitle(submission) {
  return submission.problem?.title || submission.slug.split('-').filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
}

export function submissionLanguage(language) {
  if (!language) return '';
  return languageNames.get(language) ?? language[0].toUpperCase() + language.slice(1);
}

function normalizeProblem(input) {
  if (!input || typeof input !== 'object') return undefined;
  const title = asText(input.title, 200);
  const frontendId = asText(input.frontendId, 32);
  const difficulty = Object.keys(difficultyColors).find(value => value.toLowerCase() === asText(input.difficulty, 10).toLowerCase());
  const topics = Array.isArray(input.topics)
    ? [...new Set(input.topics.slice(0, 24).map(tag => asText(tag, 80)).filter(Boolean))] : [];
  const paidOnly = typeof input.paidOnly === 'boolean' ? input.paidOnly : undefined;
  const overview = paidOnly === true ? '' : asText(input.overview, 320).split(/\s+/).slice(0, 22).join(' ');
  const raw = input.descriptionMarkdown;
  const descriptionMarkdown = paidOnly === false && typeof raw === 'string' && raw.length <= maxDescriptionBytes &&
    encoder.encode(raw).length <= maxDescriptionBytes ? raw.trim() : '';
  return { title, frontendId, difficulty, topics, paidOnly, overview, descriptionMarkdown };
}

function normalizeStats(input) {
  if (!input || typeof input !== 'object') return undefined;
  const unit = (value, pattern) => {
    const display = asText(value, 32);
    return pattern.test(display) ? display : undefined;
  };
  const percentile = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round(value * 100) / 100 : undefined;
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : undefined;
  const totalTests = count(input.totalTests);
  const testsPassed = count(input.testsPassed);
  const stats = {
    runtime: unit(input.runtime, /^\d{1,8}(?:[.,]\d{1,4})?\s*(?:ms|s|[μµ]s)$/i),
    memory: unit(input.memory, /^\d{1,8}(?:[.,]\d{1,4})?\s*(?:B|KB|MB|GB)$/i),
    runtimePercentile: percentile(input.runtimePercentile),
    memoryPercentile: percentile(input.memoryPercentile),
    totalTests: totalTests > 0 ? totalTests : undefined,
    testsPassed: totalTests > 0 && testsPassed <= totalTests ? testsPassed : undefined,
  };
  return Object.values(stats).some(value => value !== undefined) ? stats : undefined;
}

export function normalizeSubmission(input) {
  if (!input || typeof input !== 'object') throw new Error('Missing submission.');
  const { id, slug, language, code, acceptedAt } = input;
  if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) throw new Error('Invalid submission ID.');
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,149}$/.test(slug)) {
    throw new Error('Invalid problem slug.');
  }
  if (typeof language !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(language)) {
    throw new Error('Invalid language.');
  }
  if (typeof code !== 'string' || !code.trim() || code.length > MAX_CODE_BYTES ||
      encoder.encode(code).length > MAX_CODE_BYTES) {
    throw new Error('Invalid submission source.');
  }
  if (typeof acceptedAt !== 'string' || !Number.isFinite(Date.parse(acceptedAt))) {
    throw new Error('Invalid submission date.');
  }
  const problem = normalizeProblem(input.problem);
  const stats = normalizeStats(input.stats);
  const normalized = {
    id, slug, language, code,
    url: `https://leetcode.com/problems/${slug}/submissions/${id}/`,
    acceptedAt: new Date(acceptedAt).toISOString(),
  };
  if (problem) normalized.problem = problem;
  if (stats) normalized.stats = stats;
  if (typeof input.includeProblemText === 'boolean') normalized.includeProblemText = input.includeProblemText;
  if (typeof input.saveAtRoot === 'boolean') normalized.saveAtRoot = input.saveAtRoot;
  return normalized;
}

export function problemFolder({ slug, problem }) {
  const number = asText(problem?.frontendId, 32);
  return /^\d{1,10}$/.test(number) && Number(number) > 0
    ? `${Number(number)}-${slug}` : slug;
}

export function solutionFile(submission, folder) {
  const { id, slug, language, code, url, problem } = normalizeSubmission(submission);
  const extension = extensions.get(language) ?? 'txt';
  const title = submissionTitle({ slug, problem });
  return {
    path: `${folder ?? problemFolder({ slug, problem })}/${language}.${extension}`,
    message: `Solve ${title} (${submissionLanguage(language)})\n\nLeetCode submission ${id}\n${url}`,
    content: code,
  };
}

const startMarker = '<!-- leetgit:generated -->';
const endMarker = '<!-- /leetgit:generated -->';
const descriptionStart = '<!-- leetgit:description -->';
const descriptionEnd = '<!-- /leetgit:description -->';
const previewStart = '<!-- leetgit:preview -->';
const previewEnd = '<!-- /leetgit:preview -->';
const markdown = value => String(value).replace(/[\\`*_{}\[\]<>~|#!+]/g, '\\$&');
const safeBlock = value => value.replace(/<!--/g, '&lt;!--');

function packState(value) {
  const bytes = encoder.encode(JSON.stringify(value));
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

function readSavedState(block) {
  try {
    const data = /^<!-- leetgit:state ([A-Za-z0-9+/=]{1,32768}) -->/m.exec(block)?.[1];
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(data), char => char.charCodeAt(0))));
  } catch {
    return null;
  }
}

function unpackState(block, slug) {
  const raw = readSavedState(block);
  if (raw?.slug !== slug || !Array.isArray(raw.rows)) return {};
  const problem = normalizeProblem(raw.problem);
  const rows = raw.rows.slice(0, 32).flatMap(row => {
    if (!row || typeof row.id !== 'string' || !/^\d{1,20}$/.test(row.id) ||
        typeof row.language !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(row.language) ||
        typeof row.acceptedAt !== 'string' || !Number.isFinite(Date.parse(row.acceptedAt))) return [];
    return [{ id: row.id, language: row.language, acceptedAt: new Date(row.acceptedAt).toISOString(), stats: normalizeStats(row.stats) }];
  });
  return { problem, rows };
}

function findBlock(text, start, end) {
  const lines = text.split('\n');
  let offset = 0;
  let from = -1;
  let fence = '';
  for (const [index, line] of lines.entries()) {
    if (from >= 0) {
      const run = /^`{3,}/.exec(line)?.[0] ?? '';
      if (!fence && line === end) {
        return { from, to: offset + end.length, body: text.slice(from + start.length + 1, offset - 1) };
      }
      if (run && !fence) fence = run;
      else if (run.length >= fence.length && line.trim() === run) fence = '';
    }
    if (!fence && line === start && (start !== startMarker || lines[index + 1]?.startsWith('<!-- leetgit:state '))) {
      from = offset;
    }
    offset += line.length + 1;
  }
  return null;
}

export function readmeProblemSlug(readme) {
  if (typeof readme !== 'string') return null;
  const block = findBlock(readme, startMarker, endMarker);
  const slug = readSavedState(block?.body ?? '')?.slug;
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,149}$/.test(slug) ? slug : null;
}

function measured(value, percentile) {
  if (!value) return '—';
  return percentile === undefined ? value : `${value} (beats ${percentile}%)`;
}

function rowMarkdown(row, slug) {
  const { language, id, acceptedAt, stats = {} } = row;
  const file = `${language}.${extensions.get(language) ?? 'txt'}`;
  const tests = stats.testsPassed === undefined ? '—' : `${stats.testsPassed}/${stats.totalTests}`;
  const link = `https://leetcode.com/problems/${slug}/submissions/${id}/`;
  return `| [${markdown(submissionLanguage(language))}](${file}) | [Accepted](${link}) | ${measured(stats.runtime, stats.runtimePercentile)} | ${measured(stats.memory, stats.memoryPercentile)} | ${tests} | ${acceptedAt.slice(0, 10)} |`;
}

function codePreview(code, language) {
  if (encoder.encode(code).length > 24 * 1024) return '';
  let length = 3;
  for (const run of code.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
  if (length > 32) return '';
  const fence = '`'.repeat(length);
  const lexer = { python3: 'python', golang: 'go', oraclesql: 'sql', mssql: 'sql', postgresql: 'sql', mysql: 'sql' }[language] ?? language;
  return `${fence}${lexer}\n${code}${code.endsWith('\n') ? '' : '\n'}${fence}`;
}

export function problemReadme(input, existingReadme = null, folder) {
  const submission = normalizeSubmission(input);
  const { slug, id, language, code, acceptedAt, stats, includeProblemText } = submission;
  const path = `${folder ?? problemFolder(submission)}/README.md`;
  const existing = typeof existingReadme === 'string' ? existingReadme : '';
  const block = findBlock(existing, startMarker, endMarker);
  const previous = unpackState(block?.body ?? '', slug);
  const current = previous.rows?.find(row => row.language === language);
  if (current && BigInt(current.id) > BigInt(id)) return { path, content: existing, superseded: true };
  const incoming = submission.problem ?? {};
  const retained = previous.problem ?? {};
  const paidOnly = incoming.paidOnly ?? retained.paidOnly;
  const problem = {
    title: incoming.title || retained.title || undefined,
    frontendId: incoming.frontendId || retained.frontendId || undefined,
    difficulty: incoming.difficulty || retained.difficulty,
    topics: incoming.topics?.length ? incoming.topics : retained.topics ?? [],
    overview: paidOnly === true ? undefined : incoming.overview || retained.overview || undefined,
    paidOnly,
  };
  const title = `${problem.frontendId ? `${problem.frontendId}. ` : ''}${submissionTitle({ slug, problem })}`;
  const sameSubmission = current?.id === id;
  const details = sameSubmission ? { ...current.stats, ...Object.fromEntries(Object.entries(stats ?? {}).filter(([, value]) => value !== undefined)) } : stats;
  const row = { id, language, acceptedAt: sameSubmission ? current.acceptedAt : acceptedAt, stats: details && Object.keys(details).length ? details : undefined };
  const rows = [row, ...(previous.rows ?? []).filter(item => item.language !== language)]
    .sort((a, b) => BigInt(a.id) < BigInt(b.id) ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : 0).slice(0, 32);
  const priorDescription = findBlock(block?.body ?? '', descriptionStart, descriptionEnd)?.body;
  const description = includeProblemText && paidOnly === false ? incoming.descriptionMarkdown || priorDescription : '';
  const problemUrl = `https://leetcode.com/problems/${slug}/`;
  const latestLanguage = rows[0].language;
  const solution = `${latestLanguage}.${extensions.get(latestLanguage) ?? 'txt'}`;
  const preview = latestLanguage === language ? codePreview(code, language) :
    findBlock(block?.body ?? '', previewStart, previewEnd)?.body;
  const difficulty = problem.difficulty
    ? `![${problem.difficulty} difficulty](https://img.shields.io/badge/Difficulty-${problem.difficulty}-${difficultyColors[problem.difficulty]}?labelColor=35383D)` : '';
  const problemLink = `[View on LeetCode](${problemUrl})`;
  const topics = problem.topics.map(markdown).join(' · ');
  const problemText = description ? [descriptionStart, safeBlock(description), descriptionEnd] :
    problem.overview ? [`> ${markdown(problem.overview)}`] : [];
  const body = [
    startMarker,
    `<!-- leetgit:state ${packState({ slug, problem, rows })} -->`,
    '', `# ${markdown(title)}`, '',
    [difficulty, problemLink].filter(Boolean).join(' · '), '',
    ...(topics ? [`**Topics** · ${topics}`, ''] : []),
    ...(problemText.length ? ['## Problem', '', ...problemText, ''] : []),
    '## Submission results', '',
    '| Language | Verdict | Runtime | Memory | Tests passed | Date (UTC) |',
    '| --- | --- | ---: | ---: | ---: | --- |',
    ...rows.map(item => rowMarkdown(item, slug)), '',
    `## Solution · ${markdown(submissionLanguage(latestLanguage))}`, '',
    `[View source](${solution})`, '',
    ...(preview ? [previewStart, preview, previewEnd, ''] : []),
    endMarker,
  ].join('\n');
  const content = block ? existing.slice(0, block.from) + body + existing.slice(block.to) :
    existing ? `${existing}${existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'}---\n\n${body}\n` : `${body}\n`;
  return { path, content };
}

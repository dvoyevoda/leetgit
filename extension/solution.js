const extensions = new Map(Object.entries({
  bash: 'sh', c: 'c', cpp: 'cpp', csharp: 'cs', dart: 'dart', elixir: 'ex',
  erlang: 'erl', golang: 'go', java: 'java', javascript: 'js', kotlin: 'kt',
  mssql: 'sql', mysql: 'sql', oraclesql: 'sql', pandas: 'py', php: 'php',
  postgresql: 'sql', python: 'py', python3: 'py', racket: 'rkt', ruby: 'rb',
  rust: 'rs', scala: 'scala', swift: 'swift', typescript: 'ts',
}));

export const MAX_CODE_BYTES = 256 * 1024;

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
      new TextEncoder().encode(code).length > MAX_CODE_BYTES) {
    throw new Error('Invalid submission source.');
  }
  if (typeof acceptedAt !== 'string' || !Number.isFinite(Date.parse(acceptedAt))) {
    throw new Error('Invalid submission date.');
  }
  return {
    id, slug, language, code,
    url: `https://leetcode.com/problems/${slug}/submissions/${id}/`,
    acceptedAt: new Date(acceptedAt).toISOString(),
  };
}

export function solutionFile(submission) {
  const { id, slug, language, code, url } = normalizeSubmission(submission);
  const extension = extensions.get(language) ?? 'txt';
  return {
    path: `solutions/${slug}/${language}.${extension}`,
    message: `Solve ${slug} (${language})\n\nLeetCode submission ${id}\n${url}`,
    content: code,
  };
}

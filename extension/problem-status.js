function resultFor(state, slug) {
  if (state.results && Object.hasOwn(state.results, slug)) return state.results[slug];
  return state.last?.slug === slug ? state.last : null;
}

export function problemStatus(state, slug) {
  if (!slug || !state?.connection) return { pending: 0, error: null, last: null, saved: false };
  const last = resultFor(state, slug);
  return {
    pending: state.pending.filter(item => item.submission.slug === slug).length,
    error: state.pending[0]?.submission.slug === slug ? state.error : null,
    last,
    saved: !!last || state.syncedProblems?.includes(slug) === true,
  };
}

function submissionId(value) {
  return typeof value === 'string' && /^\d{1,20}$/.test(value) ? BigInt(value) : 0n;
}

export function rememberProblemResult(state, result) {
  const previous = resultFor(state, result.slug);
  const synced = state.syncedProblems ?? (state.last?.slug ? [state.last.slug] : []);
  if (!synced.includes(result.slug)) state.syncedProblems = [...synced, result.slug];
  if (previous && submissionId(previous.id) > submissionId(result.id)) return;

  const legacy = state.last?.slug ? { [state.last.slug]: state.last } : {};
  state.results = { ...(state.results ?? legacy), [result.slug]: result };
  state.last = result;
}

(() => {
  const feedback = {
    queued: ['↑', 'Saving to GitHub'],
    created: ['✓', 'Saved to GitHub'],
    updated: ['✓', 'Updated on GitHub'],
    unchanged: ['✓', 'Already saved on GitHub'],
    delayed: ['↻', 'Sync will retry'],
    blocked: ['!', 'Sync needs attention'],
  };
  const style = `
    :host { position: fixed; bottom: 24px; right: 24px; z-index: 2147483647; color-scheme: dark;
      width: min(330px, calc(100vw - 48px)); font: 13px/1.45 system-ui, sans-serif; }
    aside { position: relative; display: grid; grid-template-columns: 27px 1fr 24px; gap: 9px;
      align-items: start; padding: 12px; border: 1px solid #48423b; border-radius: 12px;
      background: #272625; color: #f9f6f2; box-shadow: 0 6px 32px #0004; }
    .mark { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px;
      background: #493613; color: #ffb746; font-weight: 750; font-size: 15px; }
    [data-state="success"] .mark { background: #183e2b; color: #74e3a5; }
    [data-state="error"] .mark { background: #553021; color: #ffb99c; }
    strong, span { display: block; overflow-wrap: anywhere; }
    .detail { margin-top: 1px; color: #cbc5bc; }
    a { display: inline-block; margin-top: 5px; color: #ffbb59; text-underline-offset: 2px; }
    button { border: 0; border-radius: 4px; background: transparent; color: #e0d8cf;
      cursor: pointer; font: 18px/24px system-ui, sans-serif; padding: 0; }
    :focus-visible { outline: 2px solid #ffbb59; outline-offset: 2px; }
    @media (max-width: 480px) { :host { right: 12px; bottom: 12px; width: min(330px, calc(100vw - 24px)); } }
  `;
  let toast;
  let timer;

  function dismiss() {
    toast?.remove();
    toast = undefined;
    clearTimeout(timer);
  }

  function show(message) {
    const display = feedback[message.status];
    if (!display || !document.documentElement) return;
    dismiss();
    toast = document.createElement('div');
    const shadow = toast.attachShadow({ mode: 'closed' });
    const css = document.createElement('style');
    css.textContent = style;
    const box = document.createElement('aside');
    const state = ['created', 'updated', 'unchanged'].includes(message.status) ? 'success' :
      ['delayed', 'blocked'].includes(message.status) ? 'error' : 'pending';
    box.dataset.state = state;
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = display[0];
    const content = document.createElement('div');
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    const heading = document.createElement('strong');
    const detail = document.createElement('span');
    detail.className = 'detail';
    status.append(heading, detail);
    content.append(status);
    const link = document.createElement('a');
    try {
      const url = new URL(message.url);
      if (state === 'success' && url.origin === 'https://github.com' && !url.username && !url.password) {
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = 'View on GitHub ↗';
        content.append(link);
      }
    } catch { /* Queued and failed messages have no link. */ }
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss SolveToGit status');
    close.addEventListener('click', dismiss);
    box.append(mark, content, close);
    shadow.append(css, box);
    document.documentElement.append(toast);
    heading.textContent = display[1];
    detail.textContent = message.message || message.title || '';
    const delay = state === 'error' ? 12000 : state === 'success' ? 8500 : 5000;
    const schedule = () => { timer = setTimeout(dismiss, delay); };
    toast.addEventListener('mouseenter', () => clearTimeout(timer));
    toast.addEventListener('mouseleave', schedule);
    toast.addEventListener('focusin', () => clearTimeout(timer));
    toast.addEventListener('focusout', schedule);
    schedule();
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'relay.feedback') return;
    const slug = /^\/problems\/([a-z0-9][a-z0-9-]{0,149})(?:\/|$)/.exec(window.location.pathname)?.[1];
    if (slug && message.slug === slug) show(message);
  });
})();

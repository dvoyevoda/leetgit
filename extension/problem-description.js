(() => {
  const maxHtml = 96 * 1024;
  const skip = new Set(['script', 'style', 'iframe', 'svg', 'math', 'form', 'img', 'video', 'audio', 'object', 'template']);
  const text = value => value.replace(/\s+/g, ' ');
  const escape = value => text(value).replace(/[\\`*_{}\[\]<>~|#!+.-]/g, '\\$&');

  function codeFence(value, language = '') {
    const runs = value.match(/`+/g) ?? [];
    const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
    return `${fence}${language}\n${value.trimEnd()}\n${fence}`;
  }

  function elements(element) {
    return Array.from(element.childNodes).map(render).join('');
  }

  function render(node) {
    if (node.nodeType === 3) return escape(node.textContent);
    if (node.nodeType !== 1) return '';
    const tag = node.localName;
    if (skip.has(tag) || node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return '';
    if (tag === 'br') return '  \n';
    if (tag === 'pre') return `\n\n${codeFence(node.textContent, 'text')}\n\n`;
    if (tag === 'code') {
      const value = text(node.textContent).trim();
      const runs = value.match(/`+/g) ?? [];
      const fence = '`'.repeat(Math.max(1, ...runs.map(run => run.length + 1)));
      return value.includes('`') ? `${fence} ${value} ${fence}` : `${fence}${value}${fence}`;
    }
    if (tag === 'ul' || tag === 'ol') {
      const lines = Array.from(node.children).filter(item => item.localName === 'li').map((item, index) => {
        const prefix = tag === 'ol' ? `${index + 1}. ` : '- ';
        return prefix + elements(item).trim().replace(/\n/g, `\n${' '.repeat(prefix.length)}`);
      });
      return `\n\n${lines.join('\n')}\n\n`;
    }
    if (tag === 'table') {
      const rows = Array.from(node.rows).map(row => Array.from(row.cells).map(cell => elements(cell).trim().replace(/\n+/g, ' ')));
      const width = rows[0]?.length;
      if (width && rows.every(row => row.length === width)) {
        rows.splice(1, 0, Array(width).fill('---'));
        return '\n\n' + rows.map(row => `| ${row.join(' | ')} |`).join('\n') + '\n\n';
      }
    }
    const children = elements(node);
    if (tag === 'strong' || tag === 'b') return children.trim() ? ` **${children.trim()}** ` : '';
    if (tag === 'em' || tag === 'i') return children.trim() ? ` *${children.trim()}* ` : '';
    if (/^h[1-6]$/.test(tag)) return `\n\n#### ${children.trim()}\n\n`;
    if (['p', 'div', 'section', 'blockquote'].includes(tag)) return `\n\n${children.trim()}\n\n`;
    if (tag === 'sup') return `^${children.trim()}`;
    if (tag === 'sub') return `_${children.trim()}_`;
    return children;
  }

  function describe(html) {
    if (typeof html !== 'string' || !html.length || html.length > maxHtml) return {};
    const template = document.createElement('template');
    template.innerHTML = html;
    const body = template.content;
    for (const node of body.querySelectorAll(`${[...skip].join(',')}, [hidden], [aria-hidden="true"]`)) node.remove();
    const intro = [...body.querySelectorAll('p')].find(node => text(node.textContent).trim()) ?? body;
    const words = text(intro.textContent).trim().split(' ').filter(Boolean);
    const overview = words.length ? words.slice(0, 22).join(' ') + (words.length > 22 ? '…' : '') : undefined;
    return { overview, descriptionMarkdown: elements(body).trim() };
  }

  globalThis.LeetGitProblem = { describe };
})();

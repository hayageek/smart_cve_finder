import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

export function markdownReportToHtml(title: string, markdown: string): string {
  const body = marked.parse(markdown) as string;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      line-height: 1.6;
      max-width: 52rem;
      margin: 0 auto;
      padding: 1.5rem 1.25rem 3rem;
      color: #1a1a1a;
      background: #fafafa;
    }
    @media (prefers-color-scheme: dark) {
      body { color: #e8e8e8; background: #111; }
      a { color: #7eb8ff; }
      code, pre { background: #1e1e1e; }
      th, td { border-color: #333; }
    }
    h1, h2, h3 { line-height: 1.25; margin-top: 1.5em; }
    h1:first-child { margin-top: 0; }
    pre {
      overflow-x: auto;
      padding: 0.75rem 1rem;
      border-radius: 6px;
      background: #f0f0f0;
    }
    code { font-size: 0.9em; padding: 0.15em 0.35em; border-radius: 4px; background: #f0f0f0; }
    pre code { padding: 0; background: transparent; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; }
    blockquote { border-left: 4px solid #ccc; margin-left: 0; padding-left: 1rem; color: #555; }
    img { max-width: 100%; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

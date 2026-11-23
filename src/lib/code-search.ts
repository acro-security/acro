export type CodeMatch = { from: number; to: number };

export function normalizeCodeLines(text: string) {
  return text.replace(/\r\n?/g, "\n");
}

export function findCodeMatches(text: string, query: string): CodeMatch[] {
  if (!query) return [];
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches: CodeMatch[] = [];
  for (const match of normalizeCodeLines(text).matchAll(new RegExp(literal, "giu"))) {
    matches.push({ from: match.index, to: match.index + match[0].length });
  }
  return matches;
}

export function firstCodeMatch(matches: CodeMatch[], offset: number) {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (matches[middle]!.to <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Shiki has already escaped the source. Walk the detached HTML so matches can
// cross syntax tokens while preserving their styles.
export function markCode(
  html: string | undefined,
  text: string,
  offset: number,
  matches: CodeMatch[],
  current?: CodeMatch,
) {
  let index = firstCodeMatch(matches, offset);
  const first = matches[index];
  if (!first || first.from >= offset + text.length) return html;

  const template = document.createElement("template");
  if (html) {
    template.innerHTML = html;
  } else {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = text;
    pre.append(code);
    template.content.append(pre);
  }

  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let from = offset;
  for (const node of nodes) {
    const to = from + node.length;
    let match = matches[index];
    if (match && match.from < to) {
      const fragment = document.createDocumentFragment();
      let cursor = from;
      while (match && match.from < to) {
        const start = Math.max(from, match.from);
        const end = Math.min(to, match.to);
        fragment.append(node.data.slice(cursor - from, start - from));
        const mark = document.createElement("mark");
        mark.className = "code-match";
        if (match === current) mark.dataset.current = "true";
        mark.textContent = node.data.slice(start - from, end - from);
        fragment.append(mark);
        cursor = end;
        if (match.to > to) break;
        match = matches[++index];
      }
      fragment.append(node.data.slice(cursor - from));
      node.replaceWith(fragment);
    }
    from = to;
  }
  return template.innerHTML;
}

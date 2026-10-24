/** Placeholder conversion for drivers that do not support anonymous `?` parameters. */
export function convertPlaceholders(sql: string, target: 'postgres' | 'mssql'): { sql: string; count: number } {
  let result = '';
  let count = 0;
  let quote: "'" | '"' | '`' | null = null;
  let lineComment = false;
  let blockComment = false;
  let dollarTag: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    const next = sql[i + 1];

    if (lineComment) {
      result += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      result += char;
      if (char === '*' && next === '/') {
        result += next!;
        i++;
        blockComment = false;
      }
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        result += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
      } else {
        result += char;
      }
      continue;
    }
    if (quote) {
      result += char;
      if (char === quote) {
        if (next === quote) {
          result += next!;
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === '-' && next === '-') {
      result += char + next!;
      i++;
      lineComment = true;
    } else if (char === '/' && next === '*') {
      result += char + next!;
      i++;
      blockComment = true;
    } else if (char === "'" || char === '"' || char === '`') {
      result += char;
      quote = char;
    } else if (char === '$') {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        result += dollarTag;
        i += dollarTag.length - 1;
      } else {
        result += char;
      }
    } else if (char === '?') {
      count++;
      result += target === 'postgres' ? `$${count}` : `@p${count}`;
    } else {
      result += char;
    }
  }
  return { sql: result, count };
}

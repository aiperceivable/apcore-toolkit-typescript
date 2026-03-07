// Generic dict-to-Markdown conversion (F07)

function _isScalar(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean';
}

function _formatScalar(value: unknown): string {
  if (value === null || value === undefined) return '*N/A*';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    return Number(value.toPrecision(4)).toString();
  }
  return String(value);
}

function _escapePipe(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function _compactRepr(value: unknown, maxLen = 80): string {
  let text: string;
  if (Array.isArray(value)) {
    const parts = value.map(v => _compactRepr(v, 30));
    text = `[${parts.join(', ')}]`;
  } else if (value !== null && typeof value === 'object') {
    const parts = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${_compactRepr(v, 30)}`,
    );
    text = `{${parts.join(', ')}}`;
  } else if (_isScalar(value)) {
    text = _formatScalar(value);
  } else {
    text = String(value);
  }
  if (text.length > maxLen) {
    text = text.slice(0, maxLen - 3) + '...';
  }
  return text;
}

function _uniformKeys(items: Record<string, unknown>[]): boolean {
  if (items.length === 0) return true;
  const ref = new Set(Object.keys(items[0]));
  return items.every(item => {
    const keys = Object.keys(item);
    return keys.length === ref.size && keys.every(k => ref.has(k));
  });
}

function _filterKeys(
  data: Record<string, unknown>,
  fields?: string[],
  exclude?: string[],
): Record<string, unknown> {
  let result = data;
  if (fields !== undefined) {
    const filtered: Record<string, unknown> = {};
    for (const k of fields) {
      if (k in data) {
        filtered[k] = data[k];
      }
    }
    result = filtered;
  }
  if (exclude && exclude.length > 0) {
    const ex = new Set(exclude);
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result)) {
      if (!ex.has(k)) filtered[k] = v;
    }
    result = filtered;
  }
  return result;
}

function _renderTable(data: Record<string, unknown>, lines: string[]): void {
  lines.push('| Field | Value |');
  lines.push('|-------|-------|');
  for (const [key, value] of Object.entries(data)) {
    lines.push(`| ${_escapePipe(String(key))} | ${_escapePipe(_formatScalar(value))} |`);
  }
  lines.push('');
}

function _renderListTable(
  items: Record<string, unknown>[],
  lines: string[],
  exclude?: string[],
): void {
  if (items.length === 0) return;
  let keys = Object.keys(items[0]);
  if (exclude && exclude.length > 0) {
    const ex = new Set(exclude);
    keys = keys.filter(k => !ex.has(k));
  }
  lines.push('| ' + keys.map(k => _escapePipe(k)).join(' | ') + ' |');
  lines.push('| ' + keys.map(() => '---').join(' | ') + ' |');
  for (const item of items) {
    const row = keys.map(k => _escapePipe(_formatScalar(item[k]))).join(' | ');
    lines.push(`| ${row} |`);
  }
  lines.push('');
}

function _renderList(
  items: unknown[],
  lines: string[],
  depth: number,
  absDepth: number,
  maxDepth: number,
  exclude?: string[],
): void {
  const indent = '  '.repeat(depth);
  if (items.length === 0) {
    lines.push(`${indent}- *(empty)*`);
    return;
  }

  // Check if items form a uniform table
  if (
    items.length >= 2 &&
    items.every(item => item !== null && typeof item === 'object' && !Array.isArray(item)) &&
    _uniformKeys(items as Record<string, unknown>[]) &&
    items.every(item =>
      Object.values(item as Record<string, unknown>).every(v => _isScalar(v)),
    )
  ) {
    _renderListTable(items as Record<string, unknown>[], lines, exclude);
    return;
  }

  const ex = exclude && exclude.length > 0 ? new Set(exclude) : null;

  for (const item of items) {
    if (_isScalar(item)) {
      lines.push(`${indent}- ${_formatScalar(item)}`);
    } else if (Array.isArray(item)) {
      lines.push(`${indent}- ${_compactRepr(item)}`);
    } else if (item !== null && typeof item === 'object') {
      if (absDepth >= maxDepth) {
        lines.push(`${indent}- ${_compactRepr(item)}`);
      } else {
        let first = true;
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
          if (ex && ex.has(k)) continue;
          const prefix = first ? `${indent}- ` : `${'  '.repeat(depth + 1)}`;
          first = false;
          if (_isScalar(v)) {
            lines.push(`${prefix}**${k}**: ${_formatScalar(v)}`);
          } else {
            lines.push(`${prefix}**${k}**: ${_compactRepr(v)}`);
          }
        }
      }
    } else {
      lines.push(`${indent}- ${_formatScalar(item)}`);
    }
  }
}

function _renderDict(
  data: Record<string, unknown>,
  lines: string[],
  depth: number,
  absDepth: number,
  maxDepth: number,
  tableThreshold: number,
  exclude?: string[],
): void {
  if (Object.keys(data).length === 0) return;

  if (exclude && exclude.length > 0) {
    const ex = new Set(exclude);
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (!ex.has(k)) filtered[k] = v;
    }
    data = filtered;
  }

  const allScalar = Object.values(data).every(v => _isScalar(v));
  if (allScalar && Object.keys(data).length >= tableThreshold) {
    _renderTable(data, lines);
    return;
  }

  const indent = '  '.repeat(depth);

  for (const [key, value] of Object.entries(data)) {
    if (_isScalar(value)) {
      lines.push(`${indent}- **${key}**: ${_formatScalar(value)}`);
    } else if (Array.isArray(value)) {
      if (absDepth + 1 >= maxDepth) {
        lines.push(`${indent}- **${key}**: ${_compactRepr(value)}`);
      } else {
        lines.push(`${indent}- **${key}**:`);
        _renderList(value, lines, depth + 1, absDepth + 1, maxDepth, exclude);
      }
    } else if (value !== null && typeof value === 'object') {
      if (absDepth + 1 >= maxDepth) {
        lines.push(`${indent}- **${key}**: ${_compactRepr(value)}`);
      } else {
        if (depth === 0) {
          const headingLevel = Math.min(absDepth + 2, 6);
          lines.push('');
          lines.push(`${'#'.repeat(headingLevel)} ${key}`);
          lines.push('');
          _renderDict(
            value as Record<string, unknown>,
            lines, 0, absDepth + 1, maxDepth, tableThreshold, exclude,
          );
        } else {
          lines.push(`${indent}- **${key}**:`);
          _renderDict(
            value as Record<string, unknown>,
            lines, depth + 1, absDepth + 1, maxDepth, tableThreshold, exclude,
          );
        }
      }
    } else {
      lines.push(`${indent}- **${key}**: ${_formatScalar(value)}`);
    }
  }
}

export function toMarkdown(
  data: Record<string, unknown>,
  options?: {
    fields?: string[];
    exclude?: string[];
    maxDepth?: number;
    tableThreshold?: number;
    title?: string;
  },
): string {
  if (data === null || data === undefined) {
    const typeName = data === null ? 'null' : 'undefined';
    throw new TypeError(`toMarkdown() expects a dict, got ${typeName}`);
  }
  if (Array.isArray(data)) {
    throw new TypeError('toMarkdown() expects a dict, got array');
  }
  if (typeof data !== 'object') {
    throw new TypeError(`toMarkdown() expects a dict, got ${typeof data}`);
  }

  const {
    fields,
    exclude,
    maxDepth = 3,
    tableThreshold = 5,
    title,
  } = options ?? {};

  const filtered = _filterKeys(data, fields, exclude);
  const lines: string[] = [];

  if (title) {
    lines.push(`# ${title}`);
    lines.push('');
  }

  _renderDict(filtered, lines, 0, 0, maxDepth, tableThreshold, exclude);

  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

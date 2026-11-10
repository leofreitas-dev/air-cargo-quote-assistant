// Tiny HTML helpers. Everything that comes from an email is untrusted, so
// every value goes through escape() before it reaches the page.

export function escape(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Marks a string as already-safe HTML (built from escaped parts). */
export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

/** Template tag: escapes every interpolated value unless it is Html (or a list of Html). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!;
  values.forEach((v, i) => {
    if (v instanceof Html) out += v.value;
    else if (Array.isArray(v)) out += v.map((x) => (x instanceof Html ? x.value : escape(x))).join('');
    else if (v === null || v === undefined || v === false) out += '';
    else out += escape(v);
    out += strings[i + 1];
  });
  return new Html(out);
}

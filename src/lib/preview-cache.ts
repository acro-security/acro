import type { PrettyInput, PrettyOutput } from "./pretty";

export function previewKey(input: PrettyInput): string {
  return JSON.stringify([input.text, input.mime, input.encoding, input.compression, !!input.http]);
}

/** Shared across mounted views, bounded by retained string bytes and entry count. */
export class PreviewCache {
  private entries = new Map<string, { value: PrettyOutput; bytes: number }>();
  private pending = new Map<string, Promise<PrettyOutput>>();
  private bytes = 0;

  constructor(
    private maxBytes = 32 * 1024 * 1024,
    private maxEntries = 128,
  ) {}

  get(key: string): PrettyOutput | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Retention shared by computed and streamed results. */
  store(key: string, value: PrettyOutput) {
    const bytes =
      2 * (key.length + value.text.length + value.html.length + (value.notice?.length ?? 0));
    if (bytes > this.maxBytes || this.maxEntries <= 0) return;
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.bytes;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value!;
      if (oldest === key) break;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }

  compute(key: string, create: () => Promise<PrettyOutput>): Promise<PrettyOutput> {
    const cached = this.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const job = Promise.resolve()
      .then(create)
      .then((value) => {
        this.store(key, value);
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }
}

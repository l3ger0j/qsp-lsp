// ── Pseudonyms ───────────────────────────────────────────────────────
//
// Neutral names for files and locations in crash reports and profiles:
// `f01` for a file, `f01_l0007` for its seventh location. Breadcrumbs
// can then say where the analysis was without saying what the game
// calls it. Files are numbered in the order this server process first
// meets them; the table of what each pseudonym stands for goes to the
// user's own copy only (see src/client/crashReports.ts).

/** Assigns and remembers the pseudonyms of one server process. */
export class Pseudonyms {
  private readonly files = new Map<string, string>();
  private readonly real = new Map<string, string>();
  private version = 0;

  /** The file's pseudonym, e.g. `f01`. */
  file(uri: string): string {
    let id = this.files.get(uri);
    if (!id) {
      id = `f${String(this.files.size + 1).padStart(2, '0')}`;
      this.files.set(uri, id);
      this.real.set(id, uri);
      this.version++;
    }
    return id;
  }

  /** The pseudonym of the location at `index` (0-based) in the file, e.g. `f01_l0007`. */
  location(uri: string, index: number, name: string): string {
    const id = `${this.file(uri)}_l${String(index + 1).padStart(4, '0')}`;
    if (this.real.get(id) !== name) {
      this.real.set(id, name);
      this.version++;
    }
    return id;
  }

  /** Grows whenever a pseudonym is added or changes meaning, to tell when to save the table again. */
  get changes(): number {
    return this.version;
  }

  /** Pseudonym → real file URI or location name. */
  table(): Record<string, string> {
    return Object.fromEntries(this.real);
  }
}

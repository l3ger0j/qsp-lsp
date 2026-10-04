// ── Text blocks for editor features ──────────────────────────────────
//
// A block passed as an argument that nothing runs is text (argBlocks.ts):
// the words in it are not variables, locations or labels to show, jump to
// or rename. Renaming `generic` must not touch `gs 'show', {generic}`,
// which passes the text `generic`.
import type { LocationSymbols, SymbolLocation } from '../parser';
import { inBlocks, textArgBlocks } from '../parser/argBlocks';
import type { DocumentState } from './featureTypes';

/** The location of that name in any analysed file. */
export function locationNamedIn(states: ReadonlyMap<string, DocumentState>): (nameLower: string) => LocationSymbols | undefined {
  return (name) => {
    for (const state of states.values()) {
      const found = state.symbols.locations.get(name);
      if (found) return found;
    }
    return undefined;
  };
}

/** The text blocks of every analysed file, worked out once per file a request asks about. */
export class TextBlocks {
  private readonly byUri = new Map<string, SymbolLocation[]>();
  private readonly locationNamed: (nameLower: string) => LocationSymbols | undefined;

  constructor(private readonly states: ReadonlyMap<string, DocumentState>) {
    this.locationNamed = locationNamedIn(states);
  }

  /** The text blocks of the file at `uri`. */
  of(uri: string): SymbolLocation[] {
    let blocks = this.byUri.get(uri);
    if (!blocks) {
      const state = this.states.get(uri);
      blocks = state ? textArgBlocks(state.symbols.locations.values(), this.locationNamed) : [];
      this.byUri.set(uri, blocks);
    }
    return blocks;
  }

  /** Whether `line`:`character` of `uri` is in a text block. */
  holds(uri: string, line: number, character: number): boolean {
    return inBlocks(this.of(uri), line, character);
  }

  /** `places` without those in text blocks. */
  outside<T extends SymbolLocation>(places: T[]): T[] {
    return places.filter(p => !this.holds(p.uri, p.line, p.column));
  }
}

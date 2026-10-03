/**
 * "Never used" diagnostics must stay silent when some locations were
 * filled by the regex fallback (lite mode on vscode.dev, a tree-sitter
 * timeout, or init before WASM is ready).
 *
 * Why
 * ───
 * Regex extraction finds only actions and labels, so a regex-only
 * location contributes no references to `referencedLocations`,
 * `referencedObjects` or `globallyRead`. Without the guard every location
 * except the first is reported as "never referenced", and anything the
 * regex-only location reads looks unused.
 */
import { extractErrors } from '../src/parser/extractErrors';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import { createConnection, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import {
  ConfigurationRequest,
  DidOpenTextDocumentNotification,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  RegistrationRequest,
  type InitializeParams,
  type PublishDiagnosticsParams,
} from 'vscode-languageserver-protocol';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { extractSymbols } from '../src/parser';
import { buildLocationIndex } from '../src/common/locations';
import { collectCallTypesPerTarget } from '../src/server/aggregation';
import { computeDiagnostics } from '../src/server/diagnostics';
import { extractLocationSymbolsFromText, locationNameCol } from '../src/server/regexFallback';
import { createQspServer } from '../src/server/common';
import { ALL_DIAGS_OFF, initParser, loadWasm } from './testHelpers';

const UNUSED_ON = { unusedLocations: true, unusedObjects: true, unusedVariables: true };

describe('unused diagnostics with regex-only locations (unit)', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(() => initParser(parser));

  // `start` defines an object and a global; `reader` uses both and calls `other`.
  const CODE = `# start\naddobj 'lamp'\n$g = 'x'\n---\n# reader\npl $g\ndelobj 'lamp'\ngt 'other'\n---\n# other\npl 1\n---\n`;
  const uri = 'test://regex-only';

  function diagnose(regexReader: boolean): string[] {
    const tree = parser.parseOnce(CODE)!;
    const { symbols } = extractSymbols(tree, uri);
    const locationIndex = buildLocationIndex(CODE);
    if (regexReader) {
      const loc = locationIndex.find(l => l.nameLower === 'reader')!;
      symbols.locations.delete('reader');
      const col = locationNameCol(CODE, loc);
      const locSyms = symbols.addLocation(loc.name, {
        uri, line: loc.startLine, column: col, endLine: loc.startLine, endColumn: col + loc.name.length,
      });
      extractLocationSymbolsFromText(CODE, loc, locSyms, uri);
    }
    const doc = TextDocument.create(uri, 'qsp', 1, CODE);
    return computeDiagnostics(
      doc, uri, locationIndex, { ...ALL_DIAGS_OFF, ...UNUSED_ON },
      collectCallTypesPerTarget([symbols]), symbols, extractErrors(tree),
    ).map(d => d.message);
  }

  it('control: with full references `reader` is flagged, the rest is used', () => {
    const msgs = diagnose(false);
    expect(msgs).toEqual([`Location 'reader' is defined but never referenced`]);
  });

  it('a regex-only location suppresses location/object/global "never used" checks', () => {
    const msgs = diagnose(true);
    expect(msgs.filter(m => /never (referenced|read|used)/.test(m))).toEqual([]);
  });
});

async function startServer(withTreeSitter: boolean) {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const serverConn = createConnection(new StreamMessageReader(c2s), new StreamMessageWriter(s2c));
  const documents = new TextDocuments(TextDocument);
  createQspServer(serverConn, documents, withTreeSitter ? loadWasm : undefined);

  const client: MessageConnection = createMessageConnection(new StreamMessageReader(s2c), new StreamMessageWriter(c2s));
  client.onRequest(RegistrationRequest.type, () => null);
  client.onRequest(ConfigurationRequest.type, (params) => params.items.map(() => null));
  client.onRequest('workspace/semanticTokens/refresh', () => null);

  const latest = new Map<string, PublishDiagnosticsParams>();
  client.onNotification(PublishDiagnosticsNotification.type, (p) => { latest.set(p.uri, p); });

  client.listen();
  await client.sendRequest(InitializeRequest.type, {
    processId: process.pid, rootUri: null, capabilities: {}, workspaceFolders: null,
  } as InitializeParams);
  client.sendNotification(InitializedNotification.type, {});

  return {
    client,
    latestMessages: (u: string) => (latest.get(u)?.diagnostics ?? []).map(d => d.message),
    stop: () => { client.dispose(); c2s.destroy(); s2c.destroy(); },
  };
}

describe('lite-mode server (no tree-sitter)', () => {
  let harness: Awaited<ReturnType<typeof startServer>> | undefined;
  afterEach(() => { harness?.stop(); harness = undefined; });

  const TEXT = `# start\ngt 'second'\n---\n# second\npl 1\n---\n# third\npl 2\n---\n`;

  async function openAndSettle(withTreeSitter: boolean): Promise<string[]> {
    harness = await startServer(withTreeSitter);
    const uri = `file:///lite-${withTreeSitter}.qsps`;
    harness.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId: 'qsp', version: 1, text: TEXT },
    });
    await new Promise((r) => setTimeout(r, 900)); // tree-tier debounce (500ms) + margin
    return harness.latestMessages(uri).filter(m => m.includes('never referenced'));
  }

  it('control: with tree-sitter only the truly unreferenced location is flagged', async () => {
    expect(await openAndSettle(true)).toEqual([`Location 'third' is defined but never referenced`]);
  }, 15_000);

  it('does not flag referenced locations as "never referenced"', async () => {
    expect(await openAndSettle(false)).toEqual([]);
  }, 15_000);
});

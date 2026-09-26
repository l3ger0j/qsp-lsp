/**
 * QSP Language Server — Node.js entry point.
 * Used on desktop (macOS, Windows, Linux) and Android (Termux).
 * Communicates via stdio transport.
 */
import * as path from 'path';
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createQspServer } from './common';
import { fsProvider, wasmFromOutDir } from './nodeHost';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// This bundle is out/server/nodeMain.js.
const { wasmLoader, wasmDir } = wasmFromOutDir(path.join(__dirname, '..'));

createQspServer(connection, documents, wasmLoader, wasmDir, fsProvider);

// ── Analysis status reporting ────────────────────────────────────────
//
// Keeps the server's AnalysisStatus and sends it to the client as a full
// snapshot (qsp/analysisStatus) whenever it changes. The client turns it
// into the language status item; see src/client/analysisStatus.ts.

import type { Connection } from 'vscode-languageserver';
import {
  ANALYSIS_STATUS_NOTIFICATION,
  type AnalysisStatus,
  type PerLocationReason,
} from '../common/analysisStatus';
import { safeConnectionCall } from './serverUtils';

export class AnalysisStatusReporter {
  private parser: AnalysisStatus['parser'] = 'starting';
  // A document can be queued for analysis twice (open, then an edit), so
  // it stays busy until every run has ended.
  private readonly busy = new Map<string, number>();
  private configured = false;
  private project: AnalysisStatus['project'];
  private readonly perLocation = new Map<string, PerLocationReason>();
  private reduced: AnalysisStatus['reduced'];
  private live = false;
  private lastSent = '';

  constructor(private readonly connection: Connection) {}

  /**
   * Begin sending. Before `initialized` the protocol allows only a few
   * messages, so changes made during `initialize` go out in this first send.
   */
  start(): void {
    this.live = true;
    this.send();
  }

  /** Stop sending, e.g. on shutdown, when only `exit` may follow. */
  stop(): void {
    this.live = false;
  }

  setParser(parser: AnalysisStatus['parser']): void {
    this.parser = parser;
    this.send();
  }

  begin(uri: string): void {
    this.busy.set(uri, (this.busy.get(uri) ?? 0) + 1);
    this.send();
  }

  end(uri: string): void {
    const n = (this.busy.get(uri) ?? 0) - 1;
    if (n > 0) this.busy.set(uri, n);
    else this.busy.delete(uri);
    this.send();
  }

  /**
   * The settings are read; `project` is the project state that follows from
   * them, set in the same snapshot so the client never sees "configured, no
   * project" on the way to "loading".
   */
  configure(project: AnalysisStatus['project']): void {
    this.configured = true;
    this.project = project;
    this.send();
  }

  get isConfigured(): boolean {
    return this.configured;
  }

  setProject(project: AnalysisStatus['project']): void {
    this.project = project;
    this.send();
  }

  setPerLocation(uri: string, reason: PerLocationReason | undefined): void {
    if (reason) this.perLocation.set(uri, reason);
    else this.perLocation.delete(uri);
    this.send();
  }

  /** The server switched to reduced analysis (see memoryGuard.ts). */
  setReduced(reduced: NonNullable<AnalysisStatus['reduced']>): void {
    this.reduced = reduced;
    this.send();
  }

  /** Drop what is known about a closed document. */
  forget(uri: string): void {
    this.busy.delete(uri);
    this.perLocation.delete(uri);
    this.send();
  }

  snapshot(): AnalysisStatus {
    return {
      parser: this.parser,
      busyUris: [...this.busy.keys()],
      configured: this.configured,
      ...(this.project ? { project: { ...this.project } } : {}),
      perLocation: Object.fromEntries(this.perLocation),
      ...(this.reduced ? { reduced: { ...this.reduced } } : {}),
    };
  }

  private send(): void {
    if (!this.live) return;
    const status = this.snapshot();
    // Most calls (a small file's per-location flag staying off, a project
    // count that didn't move) change nothing; don't repeat the snapshot.
    const key = JSON.stringify(status);
    if (key === this.lastSent) return;
    this.lastSent = key;
    safeConnectionCall(() => this.connection.sendNotification(ANALYSIS_STATUS_NOTIFICATION, status));
  }
}

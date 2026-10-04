// ── Analysis status protocol ─────────────────────────────────────────
//
// The server's state as it tells the client (qsp/analysisStatus): what is
// being analyzed right now and which degraded modes are in effect. Shared
// by the server, which sends a full snapshot on every change, and the
// client, which shows it in the language status item.

/** Custom notification carrying an {@link AnalysisStatus} snapshot. */
export const ANALYSIS_STATUS_NOTIFICATION = 'qsp/analysisStatus';

/**
 * Custom request answered once the aggregates and diagnostics running now
 * (in slices, between other requests) have all been sent. Diagnostics of
 * the files an edit changed come first, the other files' after them.
 */
export const SETTLED_REQUEST = 'qsp/settled';

export interface AnalysisStatus {
  /**
   * `full`: tree-sitter is loaded. `lite`: the host runs without it by
   * design, so analysis is regex-only. `failed`: it should have loaded but
   * didn't, which is also regex-only. `starting`: not decided yet.
   */
  parser: 'starting' | 'full' | 'lite' | 'failed';
  /** Open documents whose analysis is running now. */
  busyUris: string[];
  /**
   * False until the server has read the settings: until then it doesn't
   * know whether project mode is on, and `project` being absent means
   * nothing yet.
   */
  configured: boolean;
  /** Absent when project mode is off (once `configured`). */
  project?: { state: 'loading' | 'ready'; files: number };
  /**
   * The server ran short of memory and dropped the analysis it can do
   * without, until it restarts: the heap then, and its limit, in MB.
   */
  reduced?: { heapMB: number; limitMB: number };
}

/**
 * Documents smaller than this are analyzed without reporting: they take
 * milliseconds, and announcing them would only make the indicator flicker.
 */
export const ANALYSIS_STATUS_MIN_BYTES = 50_000;

/** What the language status item shows; the client maps it onto the VS Code API. */
export interface AnalysisStatusView {
  text: string;
  detail: string;
  /** A spinner. The client shows it only once the work has lasted a moment. */
  busy: boolean;
  warning: boolean;
}

/** The view of `status` for the document open in the active editor. */
export function describeAnalysisStatus(status: AnalysisStatus, activeUri: string | undefined): AnalysisStatusView {
  const scope = !status.configured ? 'Reading settings…'
    : status.project ? `Project: ${status.project.files} file${status.project.files === 1 ? '' : 's'}`
      : 'Single file';

  if (status.parser === 'starting') {
    return { text: 'Starting…', detail: 'Loading the QSP parser', busy: true, warning: false };
  }
  if (status.project?.state === 'loading') {
    return {
      text: 'Loading project…',
      detail: `${status.project.files} file${status.project.files === 1 ? '' : 's'} found so far`,
      busy: true,
      warning: false,
    };
  }
  if (activeUri !== undefined && status.busyUris.includes(activeUri)) {
    return { text: 'Analyzing…', detail: scope, busy: true, warning: false };
  }
  if (!status.configured) {
    return { text: 'Starting…', detail: scope, busy: true, warning: false };
  }
  if (status.parser === 'failed') {
    return {
      text: 'Limited mode',
      detail: 'The tree-sitter parser failed to load: analysis is regex-only and syntax errors are not reported. See the log.',
      busy: false,
      warning: true,
    };
  }
  if (status.reduced) {
    return {
      text: 'Reduced analysis',
      detail: `The language server ran short of memory (${status.reduced.heapMB} of ${status.reduced.limitMB} MB), so it stopped `
        + 'tracking locals passed between locations (and the checks on them) and semantic highlighting of large files, '
        + `until it restarts · ${scope}`,
      busy: false,
      warning: true,
    };
  }
  if (status.parser === 'lite') {
    return { text: 'Lite mode', detail: `Regex-only analysis in this environment · ${scope}`, busy: false, warning: false };
  }
  return { text: 'Ready', detail: scope, busy: false, warning: false };
}
